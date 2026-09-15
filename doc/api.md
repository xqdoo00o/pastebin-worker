# HTTP API reference

All examples use `{{BASE_URL}}` as the deployment origin. Paste names are
server-generated: 6 characters normally and 24 characters in private mode.
Clients cannot request a custom name.

Read-limited paste responses use `Cache-Control: no-store`. Other paste
responses use `Cache-Control: public, no-cache, must-revalidate`, so caches may
store them but must validate freshness before reuse. Unless noted otherwise,
successful operations return `200`, errors are plain text, and the API permits
cross-origin requests. A deployment may require HTTP Basic authentication for
creation requests and its web UI; public paste reads remain unauthenticated.

## Stored-paste API

### `POST /`

Create a paste from `multipart/form-data`. A normal request accepts at most
5 MiB in each form part; use the [multipart-upload API](#multipart-upload-api)
for larger content.

Form fields:

- `c` — required string or file containing the stored bytes. A file part's
  filename is saved as metadata.
- `e` — optional expiration such as `300`, `30m`, `2h`, or `25d`. The unit is
  seconds when omitted. The deployment default is `{{DEFAULT_EXPIRATION}}`;
  values above `{{MAX_EXPIRATION}}` are clamped.
- `s` — optional management password. It must be 8–128 characters with no
  newline. A random 24-character password is generated when omitted.
- `p` — optional flag; its presence selects a 24-character random name instead
  of the normal 6-character name.
- `reads` — optional non-negative integer maximum number of content reads.
  `0` means unlimited. If omitted, the deployment default is used.
- `lang` — optional syntax-highlighting language recorded for `/d/<name>` and
  returned in `X-PB-Highlight-Language`.
- `encryption-scheme` — optional client-defined encryption label. The server
  stores the bytes unchanged and returns the label in
  `X-PB-Encryption-Scheme`. Official clients use `AES-GCM-CHUNKED`.
- `filenames` — optional JSON array describing files packed into the uploaded
  object: `[ { "name": "path/file.txt", "sizeBytes": 123 } ]`. This is used
  by the official clients for archive display.
- `mimeType` — optional content hint. The accepted values are
  `text/plain;charset=UTF-8` and `application/octet-stream`; official clients
  use it for extensionless uploads.

Example response:

```json
{
  "url": "{{BASE_URL}}/BxWH2a",
  "manageUrl": "{{BASE_URL}}/BxWH2a:w2eHqyZGc@CQzWLN=BiJiQxZ",
  "expirationSeconds": 259200,
  "lastModifiedAt": "2026-08-25T10:33:06.000Z",
  "createdAt": "2026-08-25T10:33:06.000Z",
  "expireAt": "2026-08-28T10:33:06.000Z",
  "sizeBytes": 4096,
  "location": "KV",
  "remainingReads": 2,
  "filename": "example.rs",
  "filenames": [{ "name": "example.rs", "sizeBytes": 4096 }],
  "mimeType": "application/octet-stream",
  "highlightLanguage": "rust",
  "encryptionScheme": "AES-GCM-CHUNKED"
}
```

`url` is public. `manageUrl` is `url` followed by `:<password>` and is a secret
owner credential. Metadata fields that do not apply are omitted. `location` is
`KV` or `R2`; storage selection is transparent to clients.

Errors include `400` for invalid forms/options, `401` when deployment Basic
Auth fails, `413` when a direct form part exceeds 5 MiB, and `503` when an
unused random name cannot be allocated.

### `GET /<name>[.<ext>]`

### `GET /<name>/<filename>`

Return the raw stored bytes. `.<ext>` overrides MIME inference; `/<filename>`
overrides both MIME inference and the response filename. Neither form changes
stored metadata.

Query parameters:

- `a` — its presence changes `Content-Disposition` from `inline` to
  `attachment`.
- `mime=<type>` — highest-priority response MIME override.

MIME inference priority is `?mime`, requested extension/filename, stored
filename, uploaded `mimeType`, then `text/plain;charset=UTF-8`. HTML, SVG, XML,
multipart content, and deployment-configured disallowed MIME types are served
as plain text to prevent active content execution.

Response headers can include:

- `Content-Disposition`, with an RFC 5987 `filename*` when a filename is known.
- `Content-Length` and `Last-Modified`.
- `ETag` for an opened R2 object.
- `X-PB-Highlight-Language` when `lang` metadata exists.
- `X-PB-Encryption-Scheme` and `X-PB-Decrypted-Content-Type` for encrypted
  content. With no path/MIME override, ciphertext uses
  `application/octet-stream` and a stored filename gains `.encrypted`.
- `X-PB-Remaining-Reads` for a read-limited paste. It reports the count at the
  start of this successful read; the next read sees one fewer.

A valid `If-Modified-Since` at or after the paste's last modification returns
`304`. Invalid dates are ignored.

R2-backed pastes without a read limit accept a single byte range. Valid
`Range: bytes=...` requests return `206` with `Accept-Ranges`, `Content-Range`,
and `Content-Length`; unsatisfiable ranges return `416`. `If-Range` accepts the
current strong ETag or an HTTP date. Multiple/malformed ranges, ranges for KV
pastes, and ranges for read-limited pastes are ignored and receive the full
`200` response.

`404` means the paste is absent, expired, or has exhausted its read limit.

### `HEAD /<name>[.<ext>]`

Return raw-paste headers without the body and without consuming a limited
read. R2 responses advertise `Accept-Ranges`, but a `Range` header on `HEAD`
does not create a partial response. `HEAD` also works on the other `GET`
routes, although generated HTML routes may not have the raw paste's length.

### `GET /m/<name>`

Return live paste metadata as JSON without consuming a limited read:

```json
{
  "lastModifiedAt": "2026-08-25T10:33:06.000Z",
  "createdAt": "2026-08-25T10:33:06.000Z",
  "expireAt": "2026-08-28T10:33:06.000Z",
  "sizeBytes": 4096,
  "location": "R2",
  "remainingReads": 1,
  "filename": "example.rs",
  "filenames": [{ "name": "example.rs", "sizeBytes": 4096 }],
  "mimeType": "application/octet-stream",
  "highlightLanguage": "rust",
  "encryptionScheme": "AES-GCM-CHUNKED"
}
```

`lastModifiedAt`, `createdAt`, and `expireAt` are ISO 8601 strings;
`sizeBytes` is the stored byte length. Optional fields are omitted when unset.
Official `AES-GCM-CHUNKED` ciphertext starts with a 24-byte `PBE2` header and
uses independently authenticated AES-GCM chunks whose serialized non-final
size is 5 MiB. The decryption key is client-side data and is never returned by
this endpoint.

### `GET /d/<name>[.<ext>]`

### `GET /d/<name>/<filename>`

Return the browser display page. `?lang=<language>` overrides the stored
highlight language for display. Plain content may be server-rendered; binary,
archive, or encrypted content is handled by the browser client. For official
client-side encryption, append the decryption key as a URL fragment:
`/d/<name>#<key>`. Fragments are not sent to the server.

A display that loads paste content consumes one limited read.

### `GET /a/<name>`

Render the paste as sanitized HTML using GitHub-flavored Markdown, highlight.js
syntax highlighting, and MathJax. A successful request consumes one limited
read.

### `GET /u/<name>`

Interpret the paste as a URL and return `302` to that URL. The content must be
a parseable URL no longer than 2,000 bytes. Reading the body through this route
consumes one limited read, even if URL validation then fails. Invalid or
oversized URL content returns `400`.

### `GET /<name>:<password>`

Return the browser editor shell for a management URL. The page uses the
password-bearing URL to load and update the paste; the shell itself does not
validate that the paste exists. Treat this URL as a secret.

### `PUT /<name>:<password>`

Replace a paste. The request is `multipart/form-data`, requires `c`, and has
the same 5 MiB direct-content limit as `POST /`. It accepts `e`, `s`, `reads`,
`lang`, `encryption-scheme`, `filenames`, and `mimeType`; `p` has no effect.

All supplied metadata describes the replacement. Omitting `s` retains the old
password; omitting `e` or `reads` applies the corresponding deployment default;
other omitted metadata is cleared. Expiration starts again at update time. The
response has the same shape as `POST /`; always retain its `manageUrl` in case
the password changed.

Errors include `403` for a missing/wrong password, `404` for a missing paste,
and `413` when the direct content exceeds 5 MiB.

### `DELETE /<name>:<password>`

Delete a paste. A successful response says `the paste will be deleted in
seconds`; propagation can take a few seconds. A wrong password returns `403`
and a missing paste returns `404`.

## Multipart-upload API

The web UI and official [`pb`]({{REPO}}/tree/goshujin/scripts) client use R2
multipart upload for content above 5 MiB. Each non-final data part is 5 MiB.
The completed object may not exceed this deployment's `{{R2_MAX_ALLOWED}}`
limit. `key` and `uploadId` together are sensitive upload credentials.

### `POST /mpu/create[?p=1&e=<expire>]`

Allocate a random paste name and R2 multipart upload. `p` selects the
24-character private name. `e` is used for abandoned-object cleanup; send the
same expiration again on completion.

```json
{
  "name": "BxWH2a",
  "key": "BxWH2a",
  "uploadId": "..."
}
```

### `POST /mpu/create-update?name=<name>&password=<password>[&e=<expire>]`

Authenticate an existing paste and start a replacement multipart upload.
Returns the same object as `/mpu/create`. Errors are `403` for a wrong password
and `404` for a missing paste.

### `PUT /mpu/resume?key=<key>&uploadId=<id>&partNumber=<n>`

Upload one raw binary part. Part numbers start at 1. The response is R2's
uploaded-part descriptor:

```json
{ "partNumber": 1, "etag": "..." }
```

An expired, aborted, or already-completed upload returns `410`; restart from a
create endpoint.

### `POST|PUT /mpu/complete?name=<name>&key=<key>&uploadId=<id>`

Complete a new upload with `POST`, or an update created by
`/mpu/create-update` with `PUT`. Send `multipart/form-data`: `c` is a file part
containing the JSON array of uploaded-part descriptors, in order. The other
form fields are the same metadata fields accepted by normal creation/update.
The filename on `c` becomes the stored filename, so clients should use the
original/prepared content filename rather than `parts.json`.

The response is the normal paste JSON and includes an R2 `ETag` header. An
object above `{{R2_MAX_ALLOWED}}` returns `413` and is deleted best-effort.
Invalid or stale multipart state returns `410`.

### `POST /mpu/abort?key=<key>&uploadId=<id>`

Release an unfinished multipart upload. The operation is idempotent and
returns `204`, including when the upload is already absent.

## P2P API

P2P transfers use HTTP only for room management and WebSocket signaling; file
bytes travel over WebRTC (or a configured TURN relay) and are not stored in KV
or R2.

### `POST /p2p/create`

Create a room. Prefer a JSON body:

```json
{
  "expire": "6h",
  "maxTransfers": 2,
  "isPrivate": false
}
```

`expire` defaults to the deployment's P2P default and may not exceed its P2P
maximum. `maxTransfers` is a non-negative integer; `0` means unlimited.
`isPrivate: true` selects a 24-character name. For compatibility, `expire` and
`maxTransfers` may instead be query parameters; if either is present, the JSON
body is ignored.

```json
{
  "name": "BxWH2a",
  "url": "{{BASE_URL}}/p/BxWH2a",
  "displayUrl": "{{BASE_URL}}/p/BxWH2a",
  "senderToken": "...",
  "expireAt": "2026-08-25T16:33:06.000Z",
  "expirationSeconds": 21600
}
```

The `senderToken` controls the sender signaling connection and room updates;
keep it secret. Invalid options return `400`; allocation failure returns
`503`.

### `POST /p2p/update/<name>`

Replace a room's expiration window and receiver limit:

```json
{
  "senderToken": "...",
  "expire": "6h",
  "maxTransfers": 2
}
```

The response contains `expireAt`, `expirationSeconds`, `maxTransfers`,
`joinable`, `pairedReceivers`, and `successfulReceivers`. A sender token that
is invalid or no longer belongs to an active room returns `403`.

### `GET /p/<name>`

Return the browser receiver page for an active room. An expired/missing room
returns `410`. Room capacity is enforced when signaling connects, so the page
can still render for a checkpointed receiver when no new slot is available.

The receiver stores resumable progress in OPFS when available. Storage is
best-effort; stale temporary data older than 24 hours is removed on receiver
initialization and the browser may reclaim it earlier. A disconnected receiver
keeps its signaling slot for 30 seconds; checkpointed receivers can resume
after that grace period.

### `GET /p2p/ws/<name>` (WebSocket upgrade)

Connect the sender with
`?role=sender&token=<senderToken>`. Connect a receiver with
`?role=receiver&peerId=<uuid>`; the peer ID enables reconnect/checkpoint
semantics. A non-WebSocket request returns `426`, invalid roles return `400`,
invalid sender tokens return `403`, expired rooms return `410`, and receiver
admission failures return `429`.

Signaling messages are JSON and carry readiness, peer presence, SDP offers and
answers, ICE candidates, checkpoint/abandon state, room-option updates, and
ping/pong heartbeats. The official browser client is the reference
implementation; signaling alone does not carry file bytes.

## Web and documentation routes

- `GET /` — browser UI. With a `curl/*` user agent, returns the concise Markdown
  index instead.
- `GET /index.md` — concise Markdown index for any user agent.
- `GET /doc/{api,curl,skill,tos}` — rendered HTML for browsers, raw Markdown
  for `curl/*` user agents.
- `GET /doc/{api,curl,skill,tos}.md` — raw Markdown for every user agent.
- `GET /qr-receiver[/]` — QR transfer receiver supporting camera, screen
  capture, and exported APNG input. QR transfer is offline after page assets
  load and does not create a paste or P2P room.

## `OPTIONS /*` and unsupported methods

CORS preflight returns `Access-Control-Allow-Origin: *`, allows
`GET, HEAD, PUT, POST, OPTIONS`, accepts requested headers, and caches the
preflight for 86,400 seconds. A non-preflight `OPTIONS` returns the `Allow`
header, including `DELETE`. Other methods return `405`.
