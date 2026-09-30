"""Upload routing regressions; run with python -m unittest discover -s scripts."""
import importlib.machinery
import importlib.util
import io
import struct
import tempfile
from contextlib import contextmanager
from pathlib import Path
import unittest
from unittest.mock import patch, Mock


loader = importlib.machinery.SourceFileLoader("pb", str(Path(__file__).with_name("pb")))
spec = importlib.util.spec_from_loader(loader.name, loader)
pb = importlib.util.module_from_spec(spec)
loader.exec_module(pb)


class UploadRoutingTests(unittest.TestCase):
    def test_post_and_update_preserve_metadata_for_both_upload_paths(self):
        for action in ("post", "update"):
            for multipart in (False, True):
                with self.subTest(action=action, multipart=multipart):
                    arguments = [action]
                    if action == "update":
                        arguments.append("test:existing")
                    else:
                        arguments.append("--private")
                    arguments += ["--content", "hello", "--expire", "1h", "--passwd", "new", "--filename", "note.txt"]
                    args = pb.build_parser().parse_args(arguments + ["--verbose"])
                    args.dry = False
                    uploaded = []

                    def read_upload(_domain, source, _fields, **_kwargs):
                        uploaded.append(pb.read_upload_body(source))

                    with patch.object(pb, "MPU_THRESHOLD", 1 if multipart else 100), \
                         patch.object(pb, "upload_mpu", side_effect=read_upload) as mpu, \
                         patch.object(pb, "post_or_put") as direct:
                        args.func(args, "https://example.com")
                    fields = {"e": "1h", "s": "new"}
                    if multipart:
                        direct.assert_not_called()
                        self.assertEqual(uploaded, [b"hello"])
                        self.assertEqual(mpu.call_args.args[0], "https://example.com")
                        self.assertEqual(mpu.call_args.args[2], fields)
                        self.assertEqual(mpu.call_args.kwargs["name"], "test" if action == "update" else None)
                        self.assertEqual(mpu.call_args.kwargs["passwd"], "existing" if action == "update" else None)
                        self.assertEqual(mpu.call_args.kwargs["is_private"], action == "post")
                    else:
                        mpu.assert_not_called()
                        if action == "post":
                            fields["p"] = "true"
                        self.assertEqual(direct.call_args.args[:4], (
                            "PUT" if action == "update" else "POST",
                            "https://example.com/test:existing" if action == "update" else "https://example.com/",
                            fields, b"hello",
                        ))
                        self.assertEqual(direct.call_args.kwargs["log_url"], "https://example.com/test:***" if action == "update" else None)

    def test_routing_uses_encrypted_size_and_keeps_key(self):
        args = pb.build_parser().parse_args(["post", "-c", "tiny", "--encrypt", "--dry", "--verbose"])

        class EncryptedStub:
            size = 10
            encoded_key = "key"

            def __init__(self, source):
                self.source = source

        with patch.object(pb, "MPU_THRESHOLD", 8), \
             patch.object(pb, "EncryptedUploadSource", EncryptedStub), \
             patch.object(pb, "upload_mpu") as mpu:
            args.func(args, "https://example.com")
        self.assertIsInstance(mpu.call_args.args[1], EncryptedStub)
        self.assertEqual(mpu.call_args.args[2], {"encryption-scheme": pb.ENCRYPTION_SCHEME})
        self.assertEqual(mpu.call_args.kwargs["encryption_key"], "key")

    def test_multipart_update_accepts_target_name(self):
        with patch.object(pb.requests, "post") as request, patch.object(pb, "log_request") as log:
            source = pb.UploadSource(io.BytesIO(b"body"), 4)
            pb.upload_mpu("https://example.com", source, {"e": "1h"}, True, "password", False,
                          True, False, name="target")
        request.assert_not_called()
        self.assertEqual(log.call_args_list[0].args[3], {"name": "target", "password": "***"})


class UploadSourceTests(unittest.TestCase):
    def test_file_upload_reads_only_requested_parts_and_closes_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "large.bin"
            path.write_bytes(b"abcdefghij")
            with patch.object(pb, "MPU_CHUNK_SIZE", 4), patch.object(Path, "read_bytes", side_effect=AssertionError("eager read")):
                with pb.open_upload_source(str(path), None) as source:
                    self.assertEqual(source.size, 10)
                    self.assertEqual(source.part_count, 3)
                    self.assertEqual(source.read_part(2), b"ij")
                    self.assertEqual(source.read_part(0), b"abcd")
                self.assertTrue(source.stream.closed)

    def test_stdin_is_spooled_and_shortened_files_fail(self):
        with patch.object(pb.sys, "stdin", Mock(buffer=io.BytesIO(b"piped content"))):
            with pb.open_upload_source(None, None) as source:
                self.assertEqual(pb.read_upload_body(source), b"piped content")
            self.assertTrue(source.stream.closed)
        source = pb.UploadSource(io.BytesIO(b"short"), 10)
        with self.assertRaises(OSError):
            source.read_part(0)

    def test_multipart_failure_aborts_and_closes_file(self):
        created = Mock(ok=True)
        created.json.return_value = {"key": "key", "uploadId": "upload", "name": "name"}
        streams = []
        open_source = pb.open_upload_source

        @contextmanager
        def capture_source(*args):
            with open_source(*args) as source:
                streams.append(source.stream)
                yield source

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.bin"
            path.write_bytes(b"abcdefghij")
            args = pb.build_parser().parse_args(["post", str(path)])
            args.dry = False
            args.verbose = False
            with (
                patch.object(pb, "MPU_THRESHOLD", 4),
                patch.object(pb, "MPU_CHUNK_SIZE", 4),
                patch.object(pb, "open_upload_source", capture_source),
                patch.object(pb.requests, "post", return_value=created) as post,
                patch.object(pb.requests, "put", side_effect=pb.requests.ConnectionError("offline")),
            ):
                with self.assertRaises(SystemExit):
                    args.func(args, "https://example.com")
                self.assertEqual(post.call_args.args[0], "https://example.com/mpu/abort")
            self.assertTrue(streams[0].closed)

    @unittest.skipUnless(importlib.util.find_spec("cryptography"), "optional cryptography dependency")
    def test_streamed_encryption_matches_existing_wire_format(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        raw_key = bytes(range(32))
        nonce = bytes(range(8))
        for length in (0, 1, 24, 25, 72, 73, 200):
            with (
                self.subTest(length=length),
                patch.object(pb, "ENCRYPTION_PART_SIZE", 64),
                patch.object(pb.os, "urandom", side_effect=[raw_key, nonce]),
            ):
                plaintext = bytes(range(length))
                source = pb.EncryptedUploadSource(pb.UploadSource(io.BytesIO(plaintext), length))
                header = struct.pack(">4sIQ8s", b"PBE2", 64, length, nonce)
                expected = [header]
                offset = 0
                for index in range(source.part_count):
                    count = 24 if index == 0 else 48
                    counter = index.to_bytes(4, "big")
                    expected.append(AESGCM(raw_key).encrypt(
                        nonce + counter, plaintext[offset:offset + count], header + counter
                    ))
                    offset += count
                parts = [source.read_part(index) for index in range(source.part_count)]
                self.assertTrue(all(len(part) == 64 for part in parts[:-1]))
                self.assertEqual(b"".join(parts), b"".join(expected))
                self.assertEqual(source.size, sum(map(len, parts)))
                decrypted = io.BytesIO()
                pb.decrypt_stream(pb.ENCRYPTION_SCHEME, source.encoded_key, io.BytesIO(b"".join(parts)), decrypted)
                self.assertEqual(decrypted.getvalue(), plaintext)


class DownloadTests(unittest.TestCase):
    def test_plain_pipe_output_needs_no_temporary_file(self):
        args = pb.build_parser().parse_args(["get", "test"])
        response = Mock(status_code=200, headers={}, raw=io.BytesIO(b"piped bytes"))
        stdout = Mock(buffer=io.BytesIO())
        stdout.isatty.return_value = False
        with patch.object(pb.sys, "stdout", stdout), \
             patch.object(pb.tempfile, "TemporaryFile", side_effect=AssertionError("unexpected staging")):
            pb.consume_get_response(args, response)
        self.assertEqual(stdout.buffer.getvalue(), b"piped bytes")

    def test_failed_download_preserves_destination_and_removes_staging(self):
        for encrypted in (False, True):
            with self.subTest(encrypted=encrypted), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output.bin"
                output.write_bytes(b"existing")
                args = pb.build_parser().parse_args(["get", "test", "--key", "a" * 43, "-o", str(output)])
                response = Mock(status_code=200, headers={pb.ENCRYPTION_HEADER: pb.ENCRYPTION_SCHEME} if encrypted else {}, raw=io.BytesIO())

                def fail_copy(_source, destination, _size):
                    destination.write(b"partial")
                    raise OSError("interrupted")

                def fail_decryption(_scheme, _key, source, destination):
                    fail_copy(source, destination, 0)

                with patch.object(pb.shutil, "copyfileobj", side_effect=fail_copy), \
                     patch.object(pb, "decrypt_stream", side_effect=fail_decryption), \
                     self.assertRaises(OSError):
                    pb.consume_get_response(args, response)
                self.assertEqual(output.read_bytes(), b"existing")
                self.assertEqual(list(Path(directory).iterdir()), [output])

    def test_terminal_binary_check_exposes_no_partial_output(self):
        args = pb.build_parser().parse_args(["get", "test"])
        response = Mock(status_code=200, headers={}, raw=io.BytesIO(b"text\x00binary"))
        stdout = Mock(buffer=io.BytesIO())
        stdout.isatty.return_value = True
        with patch.object(pb.sys, "stdout", stdout), self.assertRaises(SystemExit):
            pb.consume_get_response(args, response)
        self.assertEqual(stdout.buffer.getvalue(), b"")

    def test_download_streams_without_reading_response_content(self):
        class BoundedSource(io.BytesIO):
            def read(self, size=-1):
                if size < 0 or size > 1024 * 1024:
                    raise AssertionError("unbounded download read")
                return super().read(min(size, 37))

        class Response:
            status_code = 200
            headers = {}
            raw = BoundedSource(b"streamed bytes" * 1000)
            close = Mock()

            @property
            def content(self):
                raise AssertionError("eager response content")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.bin"
            args = pb.build_parser().parse_args(["get", "test", "-o", str(output)])
            args.dry = False
            response = Response()
            with patch.object(pb.requests, "get", return_value=response) as get:
                pb.cmd_get(args, "https://example.com")
            self.assertEqual(output.read_bytes(), b"streamed bytes" * 1000)
            self.assertTrue(get.call_args.kwargs["stream"])
            response.close.assert_called_once()

    @unittest.skipUnless(importlib.util.find_spec("cryptography"), "optional cryptography dependency")
    def test_corrupt_or_truncated_download_never_replaces_destination(self):
        with patch.object(pb, "ENCRYPTION_PART_SIZE", 64):
            source = pb.EncryptedUploadSource(pb.UploadSource(io.BytesIO(b"secret" * 30), 180))
            encrypted = b"".join(source.read_part(i) for i in range(source.part_count))
            for corrupted in (encrypted[:-1], encrypted[:-1] + bytes([encrypted[-1] ^ 1]), encrypted + b"extra"):
                with tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / "output.bin"
                    output.write_bytes(b"existing")
                    args = pb.build_parser().parse_args(["get", "test", "--key", source.encoded_key, "-o", str(output)])
                    args.dry = False
                    response = Mock(status_code=200, headers={pb.ENCRYPTION_HEADER: pb.ENCRYPTION_SCHEME}, raw=io.BytesIO(corrupted))
                    with patch.object(pb.requests, "get", return_value=response), self.assertRaises(SystemExit):
                        pb.cmd_get(args, "https://example.com")
                    self.assertEqual(output.read_bytes(), b"existing")
                    response.close.assert_called_once()


class HistoryTests(unittest.TestCase):
    def test_base64url_key_with_hyphens_preserves_password_and_key(self):
        key = pb.b64_variant_encode(bytes([251]) * 32)
        self.assertIn("-", key)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history"
            path.write_text(f"target:password#with#hash#{key}\n")
            with patch.object(pb, "ensure_history", return_value=path):
                self.assertEqual(pb.lookup_credentials("target"), ("password#with#hash", key))

    def test_latest_password_retains_last_nonempty_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history"
            key = "a" * 43
            path.write_text(f"target:old#{key}\nother:ignored\ntarget:new\n")
            with patch.object(pb, "ensure_history", return_value=path):
                self.assertEqual(pb.lookup_credentials("target"), ("new", key))
                self.assertEqual(pb.lookup_credentials("missing"), (None, None))


if __name__ == "__main__":
    unittest.main()
