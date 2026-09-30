# Optical wire format v2

Each QR code is self-describing and contains a variable-length optical header
followed by one RFC 6330 encoding packet. There is no handshake.

## Optical header

Every frame begins with the following 16 bytes:

| Offset | Size | Field            | Encoding                                                                   |
| -----: | ---: | ---------------- | -------------------------------------------------------------------------- |
|      0 |    2 | Magic            | `D1 C3`                                                                    |
|      2 |    1 | Version          | `02`                                                                       |
|      3 |    4 | Container length | unsigned, little-endian                                                    |
|      7 |    8 | Container tag    | complete `XXH3-64(exact DCF5 container bytes)`, canonical big-endian order |
|     15 |    1 | Part placement   | high 4 bits = total pieces minus one; low 4 bits = zero-based piece index  |

When part count is non-zero, the frame has eight additional bytes:

| Offset | Size | Field       | Encoding                                                          |
| -----: | ---: | ----------- | ----------------------------------------------------------------- |
|     16 |    8 | Transfer id | complete `XXH3-64(whole uncompressed file)`, canonical big-endian |

Therefore `H`, the optical-header length, is 16 bytes for a standalone file
and 24 bytes for a multipart piece. Part count zero requires part index zero
and has no transfer id. Part count `n > 0` represents `n + 1` total pieces and
requires an eight-byte transfer id.

The receiver uses part placement and transfer id before RaptorQ decoding. Once
a multipart receive is in progress, it ignores standalone files, other
transfer ids, different part counts, and pieces that have already been
received. Once a RaptorQ matrix starts collecting one container, frames from a
different stream cannot replace that matrix.

The next four bytes are the standard FEC Payload ID: an 8-bit Source Block
Number followed by a 24-bit Encoding Symbol ID, both in network byte order.
The remaining bytes are one encoding symbol.

## Implicit RFC 6330 parameters

The application profile fixes or derives every parameter that does not vary
per symbol:

| Parameter | Value                                                    |
| --------- | -------------------------------------------------------- |
| F         | DCF5 container length from the optical header            |
| Al        | 8 bytes                                                  |
| T         | decoded QR payload length minus `H` and 4 FEC-ID bytes   |
| Z         | 1 source block                                           |
| N         | 1 sub-block                                              |
| K         | `ceil(F / T)`                                            |
| SBN       | 0                                                        |
| ESI       | FEC Payload ID bytes 1–3, interpreted as unsigned 24-bit |

`T` is aligned down to a multiple of `Al`. The final source symbol is padded
to `T` for encoding and recovered output is truncated to `F`. This profile
sends repair symbols only: source-symbol ESIs `0 ... K-1` and non-zero source
blocks are rejected; accepted repair ESIs are `K ... 2^24-1`.

A separate sequence, `K`, or block-length field would duplicate information
already available from the FEC Payload ID, packet dimensions, or `F`.

## DCF5 container

DCF5 contains file metadata and transmitted bytes only. Part placement and
transfer id exist exclusively in the optical frame header.

The media type may include the optional
`x-pb-highlight=<highlight.js-language>` parameter. Receivers use it as the
syntax-highlighting hint and do not infer a language independently. The
parameter does not affect the media-type essence. An explicit `plaintext`
value records that the sender deliberately disabled highlighting.

| Offset |     Size | Field                                    | Encoding                                              |
| -----: | -------: | ---------------------------------------- | ----------------------------------------------------- |
|      0 |        4 | Magic                                    | ASCII `DCF5`                                          |
|      4 |        1 | Compression                              | 0 = none, 1 = zstd, 2 = whole-frame zstd fragment     |
|      5 |        2 | File-name length                         | unsigned, little-endian                               |
|      7 |        2 | Media-type length                        | unsigned, little-endian                               |
|      9 |        4 | Original byte length                     | unsigned, little-endian                               |
|     13 |        4 | Transmitted byte length                  | unsigned, little-endian                               |
|     17 | variable | File name, media type, transmitted bytes | UTF-8 file name, UTF-8 media type, then exact payload |

The original-byte-length field depends on compression mode:

- `none`: byte length of this piece's raw payload.
- `zstd`: byte length of the complete file after decompression.
- `zstd fragment`: byte length of the complete file after decompression,
  repeated in every piece. Concatenating fragments in part order reconstructs
  one standard zstd frame, which is then decompressed once.

Empty payloads are invalid. File-name and media-type lengths are each limited
to 65,535 UTF-8 bytes. A transmitted piece payload is limited to 64 MiB; the
DCF5 container can be larger by its 17-byte header and metadata. Part placement
supports at most 16 pieces, and the configured whole-file limit is 1 GiB.

The sender selects a smaller part budget for low-capacity QR settings: 24 MiB
at 500 bytes/frame, 48 MiB at 1000 bytes/frame, and 64 MiB at the remaining
offered settings. Raw payloads can fill that budget; zstd fragments reserve
the DCF header, metadata, and an additional 64 bytes within it. Partitioning
uses the payload after compression. The 16-piece limit is unchanged, so raw
transfers are limited to 384 MiB, 768 MiB, and 1 GiB respectively. These are
sender policies; the v2 wire format and receiver limits are unchanged.

Changing the sender's part budget reuses the prepared payload and whole-file
hash. Only the part boundaries and containers are rebuilt; changing the source
file or its media type releases the preparation. A budget that exceeds the
16-piece limit can be retried with a larger budget without recompressing.

The sender reduces the file name to a safe basename. A missing media type is
inferred from the file extension or encoded as `application/octet-stream`.
Receivers apply filename sanitization again before presenting a download.

## Integrity and multipart assembly

DCF5 has no embedded per-container digest. After RaptorQ recovery, the decoder
hashes the exact DCF5 bytes and compares the result with the optical-header
container tag before the container reaches the UI. This check covers the DCF5
structure, file metadata, compressed representation, and payload.

Every multipart frame carries the same transfer id: `XXH3-64` of the complete
uncompressed file. The receiver additionally requires matching total part
count, file name, media type, compression mode, and decompressed length across
pieces. After ordered assembly or streaming decompression, it hashes the final
file and compares it with the transfer id.

The receiver writes contiguous parts directly to its OPFS output. Parts that
arrive before a missing predecessor are immediately stored in separate OPFS
temporary files; only their file handles and transfer metadata remain in the
assembler. As gaps are filled, staged parts are read in bounded chunks,
appended or streamed through the whole-frame zstd decoder in index order,
and deleted. Reset and failure clean up the staged files and unfinished output.

The container tag identifies one exact DCF5 object; the transfer id groups the
different containers belonging to one file. Repair symbols can be combined
across sender restarts only when container tag, transfer metadata, part
placement, container length, and RaptorQ packet length all match.

XXH3 detects accidental corruption and is not sender authentication. A
malicious sender can deliberately replace header and payload values; an
authenticated transport or signature is required when authenticity matters.

## APNG carrier profile

APNG export does not change the QR wire bytes. The carrier is a full-frame,
1-bit indexed black/white APNG and contains exactly one uncompressed `iTXt`
record with keyword `qr-transfer`. Its UTF-8 JSON value is an atomic geometry
record:

```json
{ "scale": 4, "grid": 9, "qr": 40 }
```

`scale` is the number of physical PNG pixels per module, `grid` is the number
of QR cells, and `qr` is the supported QR version shared by every cell. The
exporter writes the record before `acTL`; the receiver requires and validates
it before the first `fcTL`. Width and height must exactly equal the declared
grid of `(17 + 4 × qr + 8) × scale` cells, where eight accounts for the
four-module quiet zone on each side. Files without this record are rejected.

During import, each replicated `scale × scale` pixel block is collapsed to one
packed bit. The WASM codec then slices the validated grid into exact QR module
matrices and enters zxing-cpp at the decoder stage, bypassing symbol detection
and perspective sampling.

## QR carrier profile

Live display, camera/screen capture, and APNG use the same restricted QR
carrier. The complete optical frame below is encoded as raw binary bytes;
there is no text, Base64, or character-set conversion layer.

| Property         | Required value                                                   |
| ---------------- | ---------------------------------------------------------------- |
| QR family        | Model 2 versions 1–40 plus transfer-only v48 (209×209 modules)     |
| Error correction | L, M, Q, or H, as indicated by the QR format information         |
| Data mask        | **3**, with mask condition `(x + y) % 3 == 0`                    |
| Segments         | Exactly one Byte-mode segment (`0100`)                           |
| Byte count       | 8 bits for versions 1–9; 16 bits for versions 10–40 and v48      |
| Quiet zone       | At least four light modules on every side; the sender emits four |

The byte-count field contains the complete optical-frame length, including
its header and FEC Payload ID. Payload bytes and count bits are written most
significant bit first. After the payload, append up to four zero terminator
bits (limited by the remaining data capacity), zero bits to the next byte
boundary, then alternating `EC 11` hexadecimal pad bytes starting with `EC`
until the selected version/ECC data capacity is full. Apply the normal QR
Reed–Solomon encoding, interleaving, remainder bits, and mask 3.

Version 48 extends the Model 2 alignment positions to
`6, 34, 62, 90, 118, 146, 174, 202` and uses the same version BCH field.
Its byte-mode capacities are 4143 (L), 2953 (M), 2331 (Q), and 1450 (H).
Versions 41–47 are not used. The sender offers one new B/frame size, 4143,
at ECC L; existing sizes 2953 and 2331 can now be used at ECC M and Q.

ECI, Structured Append, FNC1, numeric/alphanumeric/Kanji modes, additional
segments, other masks, and nonstandard padding are outside this profile.
The receiver uses a dedicated decoder for this profile on both the camera
and APNG paths; it does not fall back to general-purpose QR decoding.
Matching optical-frame bytes alone are therefore insufficient for sender
interoperability. Mirrored sampling and format/version error correction
remain supported. This documents the existing carrier restrictions without
changing the v2 optical header.

### Carrier test vectors

[qr-carrier.json](test-vectors/qr-carrier.json) contains fixed payload and
module-matrix vectors for version 1-L (full byte capacity), version 2-L
(8-bit byte count), and version 10-Q (16-bit byte count). `payloadHex` is the
exact Byte-segment content. `modulesHex` packs the `(17 + 4 × version)` square
matrix in row-major order, least-significant bit first, with dark modules set
to one, no quiet zone, and unused final bits zero. This storage convention is
separate from the most-significant-bit-first QR data encoding above.

These test the QR carrier independently: the short version-1 payload is not
an optical frame, and the header examples do not constitute a complete file
transfer. Tests compare both independent encoders with the frozen matrices,
decode them through both SIMD/scalar camera and APNG paths, and check rejection
of other masks, ECI, multiple segments, invalid counts/terminators, and padding.

Protocol references: [RFC 6330 FEC Payload ID](https://www.rfc-editor.org/rfc/rfc6330.html#section-3.2),
[object-delivery parameters](https://www.rfc-editor.org/rfc/rfc6330.html#section-4.2),
[source-block construction](https://www.rfc-editor.org/rfc/rfc6330.html#section-4.4.1), and
[security considerations](https://www.rfc-editor.org/rfc/rfc6330.html#section-6).
