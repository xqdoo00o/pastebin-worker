---
name: shz-al
description: Upload, fetch, inspect, update, or delete text and binary content through {{BASE_URL}}. Use for a temporary public URL, a small file, rendered Markdown, a URL redirect, or browser-based P2P/QR transfer.
---

# Pastebin Worker

Use `{{BASE_URL}}` as the API origin. Stored pastes receive a random 6-character
name, or a random 24-character name in private mode. The API does not support
client-selected names.

## Safety and selection rules

- Treat every normal paste URL as public. Private mode makes the name difficult
  to guess; it does not add authentication or encryption.
- Never expose the returned `manageUrl`: it is the credential for replacement
  and deletion. Share only `url` or `/d/<name>`.
- Direct `POST`/`PUT` content is limited to 5 MiB. For larger content, use the
  web UI or the [`pb`]({{REPO}}/tree/goshujin/scripts) client, which uses R2
  multipart upload up to the deployment limit (`{{R2_MAX_ALLOWED}}`).
- Setting `encryption-scheme` only labels already-encrypted bytes; the server
  does not encrypt them. Use the web UI or `pb -E` when actual client-side
  encryption is required.
- A raw `GET`, rendered display/article, or URL redirect consumes one read from
  a read-limited paste. Inspect with `HEAD` or `/m/<name>` first when reads are
  scarce.

If this deployment requires HTTP Basic authentication, add
`-u '<user>:<password>'` to creation requests.

## Create a stored paste

```shell
curl -sS -F c='hello, world' {{BASE_URL}}                 # text
curl -sS -F c=@file.png {{BASE_URL}}                      # file
<command> | curl -sS -F c=@- {{BASE_URL}}                 # stdin
```

The JSON response contains at least:

```json
{
  "url": "{{BASE_URL}}/BxWH2a",
  "manageUrl": "{{BASE_URL}}/BxWH2a:<password>",
  "expirationSeconds": 259200,
  "expireAt": "2026-08-28T10:33:06.000Z",
  "sizeBytes": 12,
  "location": "KV"
}
```

Retain the complete response when later management or metadata is relevant.

Optional form fields:

- `-F e=<duration>` — expiration (`30m`, `2h`, `14d`; default
  `{{DEFAULT_EXPIRATION}}`, maximum `{{MAX_EXPIRATION}}`).
- `-F p=1` — use a 24-character unguessable random name.
- `-F reads=<integer>` — maximum content reads; `0` means unlimited.
- `-F s=<password>` — management password, 8–128 characters, no newline.
- `-F lang=<language>` — syntax highlighting on `/d/<name>`.

Example with common options:

```shell
curl -sS \
  -F c=@report.md \
  -F e=7d \
  -F p=1 \
  -F reads=3 \
  -F lang=markdown \
  {{BASE_URL}}
```

## Inspect and fetch

```shell
curl -sS {{BASE_URL}}/m/<name> | jq .      # metadata; does not consume a read
curl -sSI {{BASE_URL}}/<name>              # headers; does not consume a read
curl -sS {{BASE_URL}}/<name>               # raw bytes; consumes a limited read
curl -sS -OJ {{BASE_URL}}/<name>           # save using stored filename
curl -sS -OJ '{{BASE_URL}}/<name>?a'       # force attachment disposition
```

Useful URL forms:

- `/<name>.json` or `/<name>/file.json` — override MIME inference; the latter
  also overrides the response filename.
- `/<name>?mime=application/json` — explicit MIME override.
- `/d/<name>?lang=rust` — browser display/highlighting page.
- `/a/<name>` — sanitized GitHub-flavored Markdown + MathJax rendering.
- `/u/<name>` — `302` redirect when the paste contains a valid URL of at most
  2,000 bytes.

R2-backed pastes without read limits support a single HTTP byte range and
resumable downloads. KV-backed and read-limited pastes ignore `Range`.

## Update or delete

Use the exact secret `manageUrl` returned by creation:

```shell
curl -sS -X PUT -F c='replacement' '<manageUrl>'
curl -sS -X DELETE '<manageUrl>'
```

`PUT` replaces the content. `-F e=...` starts a new expiration window,
`-F reads=...` resets the read limit, and `-F s=...` rotates the management
password. Use the new response's `manageUrl` after every update.

## Large files and encrypted content

Prefer the official CLI rather than manually orchestrating `/mpu/*`:

```shell
pb post -f large.bin
pb post -E -f sensitive.bin
pb get --save <name>
pb update -f replacement.bin '<name>:<password>'
pb delete '<name>:<password>'
```

`pb` switches to multipart upload above 5 MiB, retains management credentials
in its history, refuses binary terminal output by default, and can encrypt or
decrypt `AES-GCM-CHUNKED` content locally. Its encrypted display URL puts the
key after `#`, so the key is never sent to the server.

## Browser transfer modes

- P2P mode in the main UI sends files browser-to-browser over WebRTC and does
  not store their bytes on the pastebin. The share URL is `/p/<room>`.
- QR mode streams prepared data screen-to-camera without uploading it. Open
  `{{BASE_URL}}/qr-receiver` on the receiver; it supports camera, screen
  capture, and exported APNG input.

Use these modes through the browser UI unless implementing their signaling or
optical protocols deliberately.

## Failure handling

- `400`: correct the form field, expiration, read limit, or path.
- `401`: provide deployment HTTP Basic authentication.
- `403`: management password or P2P sender token is wrong.
- `404`: paste is absent, expired, or has exhausted its reads.
- `410`: multipart upload or P2P room has expired; start a new one.
- `413`: direct content exceeds 5 MiB, or completed multipart content exceeds
  `{{R2_MAX_ALLOWED}}`.
- `416`: requested R2 byte range is unsatisfiable.

## Complete references

- [curl guide]({{BASE_URL}}/doc/curl.md)
- [HTTP API reference]({{BASE_URL}}/doc/api.md)
- [service index]({{BASE_URL}}/index.md)
