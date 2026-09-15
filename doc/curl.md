# CLI usage with `curl`

This guide covers the stored-paste HTTP API from a shell. For every endpoint
and response field, see the [HTTP API reference]({{BASE_URL}}/doc/api).

## Conventions

- `<name>` is a generated paste name: 6 characters normally, or 24 characters
  in private mode.
- `<manage-url>` is the secret `manageUrl` returned by an upload. Do not share
  it: anyone who has it can replace or delete the paste.
- Expirations accept an integer or decimal plus an optional unit: `s` (the
  default), `m`, `h`, or `d`. Examples: `300`, `30m`, `2h`, `25d`.

If the deployment requires HTTP Basic authentication, add
`-u '<user>:<password>'` to upload and P2P-management requests.

## Upload

### Text, files, and stdin

```shell
$ curl -F c='hello, world' {{BASE_URL}}
$ curl -F c=@photo.jpg {{BASE_URL}}
$ printf 'hello\n' | curl -F c=@- {{BASE_URL}}
```

A successful upload returns metadata and two URLs:

```json
{
  "url": "{{BASE_URL}}/BxWH2a",
  "manageUrl": "{{BASE_URL}}/BxWH2a:w2eHqyZGc@CQzWLN=BiJiQxZ",
  "expirationSeconds": 259200,
  "lastModifiedAt": "2026-08-25T10:33:06.000Z",
  "createdAt": "2026-08-25T10:33:06.000Z",
  "expireAt": "2026-08-28T10:33:06.000Z",
  "sizeBytes": 12,
  "location": "KV"
}
```

Share `url`; retain `manageUrl` privately for updates and deletion. When `c`
is uploaded as a file, its filename is returned on downloads through
`Content-Disposition`.

### Upload options

```shell
$ curl -F c='temporary' -F e=30m {{BASE_URL}}       # expiration
$ curl -F c='secret'    -F p=1   {{BASE_URL}}       # 24-character random name
$ curl -F c='read once' -F reads=1 {{BASE_URL}}     # burn after one content read
$ curl -F c=@main.rs    -F lang=rust {{BASE_URL}}   # display-page highlighting
$ curl -F c='content'   -F s='correct-horse' {{BASE_URL}} # management password
```

- Omitting `e` uses the deployment default (`{{DEFAULT_EXPIRATION}}` here).
  Requested expirations above the deployment maximum
  (`{{MAX_EXPIRATION}}` here) are clamped to that maximum.
- `reads` must be a non-negative integer. `0` means unlimited. A content read
  through the raw, display, article, or redirect route consumes one read;
  `HEAD` and `/m/<name>` do not.
- A custom management password must contain 8–128 characters and no newline.
  If `s` is omitted, the service generates one.
- Paste names cannot be selected by the client; `p` only chooses between the
  short and long random-name formats.

The low-level API accepts at most 5 MiB of content in a normal `POST` or `PUT`.
For larger content, use the web UI or the
[`pb`]({{REPO}}/tree/goshujin/scripts) CLI; they automatically use 5 MiB R2
multipart parts up to this deployment's `{{R2_MAX_ALLOWED}}` limit.

## Fetch

### Raw content

```shell
$ curl {{BASE_URL}}/BxWH2a
hello, world

$ curl -OJ {{BASE_URL}}/BxWH2a               # use the stored filename
$ curl '{{BASE_URL}}/BxWH2a?a' -OJ           # force attachment disposition
$ curl {{BASE_URL}}/BxWH2a | jq .             # pipe to another tool
```

You can override the response filename or MIME type without changing the
stored paste:

```shell
$ curl -OJ {{BASE_URL}}/BxWH2a/report.json
$ curl -i {{BASE_URL}}/BxWH2a.json
$ curl -i '{{BASE_URL}}/BxWH2a?mime=application/json'
```

MIME priority is `?mime`, path extension/filename, stored filename, uploaded
MIME hint, then `text/plain`. Potentially active types such as HTML, SVG, XML,
and configured disallowed types are served as plain text.

### Metadata and conditional requests

```shell
$ curl {{BASE_URL}}/m/BxWH2a | jq .
$ curl -I {{BASE_URL}}/BxWH2a
$ curl -i -H 'If-Modified-Since: Tue, 25 Aug 2026 10:33:06 GMT' \
    {{BASE_URL}}/BxWH2a
```

`HEAD` returns the raw response headers without its body. Ordinary paste
responses use `Cache-Control: public, no-cache, must-revalidate`; read-limited
responses use `no-store`. A matching `If-Modified-Since` returns `304 Not
Modified`.

R2-backed pastes without a read limit also support one byte range:

```shell
$ curl -H 'Range: bytes=0-1048575' {{BASE_URL}}/BxWH2a -o first-megabyte.bin
$ curl -C - -O {{BASE_URL}}/BxWH2a              # resume when the server advertises ranges
```

Range requests return `206` when satisfied and `416` when unsatisfiable. They
are ignored for KV-backed and read-limited pastes.

## Display, Markdown, and redirects

```shell
$ firefox {{BASE_URL}}/d/BxWH2a                  # display/highlight in browser
$ firefox '{{BASE_URL}}/d/BxWH2a?lang=rust'      # override display language
$ firefox {{BASE_URL}}/a/BxWH2a                  # render Markdown as HTML
$ curl -L {{BASE_URL}}/u/BxWH2a                  # redirect to pasted URL
```

`/a` supports GitHub-flavored Markdown, syntax highlighting, and MathJax.
`/u` only redirects when the paste is a valid URL no longer than 2,000 bytes.

## Update and delete

Capture the management URL from the upload response:

```shell
$ response=$(curl -sS -F c=@notes.md {{BASE_URL}})
$ paste_url=$(printf '%s' "$response" | jq -r .url)
$ manage_url=$(printf '%s' "$response" | jq -r .manageUrl)

$ curl -X PUT -F c=@revised-notes.md "$manage_url"
$ curl -X DELETE "$manage_url"
the paste will be deleted in seconds
```

`PUT` replaces the content and accepts the upload metadata fields. Supplying
`e` starts a new expiration period from the update time; supplying `s` rotates
the management password. The returned `manageUrl` is therefore authoritative.
Deletion can take a few seconds to propagate globally.

## P2P and QR transfer

The browser UI at `{{BASE_URL}}` also supports direct WebRTC P2P transfer and
offline screen-to-camera QR transfer. These modes do not create stored-paste
URLs. Open `{{BASE_URL}}/qr-receiver` on the receiving device for QR camera,
screen-capture, or exported-APNG reception. See the
[API reference]({{BASE_URL}}/doc/api#p2p-api) if implementing a P2P client.

## Common errors

| Status | Meaning                                                                                            |
| -----: | -------------------------------------------------------------------------------------------------- |
|  `400` | Invalid path, multipart form, option, or P2P request.                                              |
|  `401` | HTTP Basic authentication is required or failed.                                                   |
|  `403` | The management password or P2P sender token is wrong.                                              |
|  `404` | The paste or document does not exist.                                                              |
|  `410` | A P2P room or multipart upload has expired.                                                        |
|  `413` | A direct content part exceeds 5 MiB, or a completed multipart object exceeds `{{R2_MAX_ALLOWED}}`. |
|  `416` | An R2 byte range is unsatisfiable.                                                                 |
|  `500` | Unexpected server error.                                                                           |
|  `503` | A random paste name or P2P room could not be allocated after retries.                              |

For multipart endpoint details, response headers, and P2P room creation, see
the [full HTTP API reference]({{BASE_URL}}/doc/api).
