import type { MPUCreateResponse } from "../../shared/interfaces.js"
import { PASTE_NAME_LEN, PRIVATE_PASTE_NAME_LEN } from "../../shared/constants.js"
import { jsonResponse, WorkerError } from "../common.js"
import { allocateRandomPasteName } from "../storage/storage.js"
import { newPasteObjectKey, pasteNameFromObjectKey } from "../storage/objectKey.js"
import { assertPastePassword, requirePasteMetadata } from "../pasteAccess.js"
import { parseSize } from "../../shared/parsers.js"

function createMultipartUploadResponse(name: string, multipartUpload: { key: string; uploadId: string }): Response {
  const response: MPUCreateResponse = {
    name,
    key: multipartUpload.key,
    uploadId: multipartUpload.uploadId,
  }
  return jsonResponse(response)
}

function requireSearchParams<const Names extends readonly string[]>(
  url: URL,
  names: Names,
  errorMessage: string,
): Record<Names[number], string> {
  const values = Object.fromEntries(names.map((name) => [name, url.searchParams.get(name)]))
  if (names.some((name) => values[name] === null)) throw new WorkerError(400, errorMessage)
  return values as Record<Names[number], string>
}

// POST /mpu/create?p=<optional isPrivate>
// returns JSON { name: string, key: string, uploadId: string }
export async function handleMPUCreate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const isPrivate = url.searchParams.get("p") !== null

  const name = await allocateRandomPasteName(env, isPrivate ? PRIVATE_PASTE_NAME_LEN : PASTE_NAME_LEN)

  // The final expiration is selected at completion and stored in KV. A time
  // fixed here would count upload time against the paste's promised lifetime.
  const multipartUpload = await env.R2.createMultipartUpload(newPasteObjectKey(name))
  return createMultipartUploadResponse(name, multipartUpload)
}

// POST /mpu/create-update?name=<name>&password=<password>
// returns JSON { name: string, key: string, uploadId: string }
export async function handleMPUCreateUpdate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const { name, password } = requireSearchParams(
    url,
    ["name", "password"] as const,
    "missing name or password (password) in searchParams",
  )

  const metadata = await requirePasteMetadata(env, name)
  assertPastePassword(name, password, metadata)

  const multipartUpload = await env.R2.createMultipartUpload(newPasteObjectKey(name))
  return createMultipartUploadResponse(name, multipartUpload)
}

// PUT /mpu/resume?key=<key>&uploadId=<uploadId>&partNumber=<partNumber>
// return JSON { partNumber: number, etag: string }
export async function handleMPUResume(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  const {
    uploadId,
    partNumber: partNumberString,
    key,
  } = requireSearchParams(
    url,
    ["uploadId", "partNumber", "key"] as const,
    "missing partNumber or uploadId or key in searchParams",
  )
  if (request.body === null) {
    throw new WorkerError(400, "missing request body")
  }

  const partNumber = Number(partNumberString)
  if (!/^[1-9]\d*$/.test(partNumberString) || !Number.isSafeInteger(partNumber)) {
    throw new WorkerError(400, "invalid partNumber")
  }
  const multipartUpload = env.R2.resumeMultipartUpload(key, uploadId)
  let uploadedPart: R2UploadedPart
  try {
    uploadedPart = await multipartUpload.uploadPart(partNumber, request.body)
  } catch (e) {
    // Most commonly: uploadId has been aborted, completed, or expired. R2 may also
    // throw transient service errors here, but those are rare enough that lumping
    // them as 410 is acceptable — the client retries from /mpu/create either way.
    console.warn(`MPU resume failed for key=${key}, uploadId=${uploadId}, part=${partNumber}: ${String(e)}`)
    throw new WorkerError(410, "multipart upload no longer exists; please retry from /mpu/create")
  }
  return jsonResponse(uploadedPart)
}

// POST /mpu/abort?key=<key>&uploadId=<uploadId>
// Releases R2-side multipart state for an upload that won't be completed.
// Knowing key + uploadId is the auth: both are returned from /mpu/create
// to whoever initiated the upload and aren't stored elsewhere.
// Idempotent: an unknown / already-aborted / completed uploadId still returns 204.
export async function handleMPUAbort(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const { uploadId, key } = requireSearchParams(
    url,
    ["uploadId", "key"] as const,
    "missing uploadId or key in searchParams",
  )
  try {
    await env.R2.resumeMultipartUpload(key, uploadId).abort()
  } catch (e) {
    console.warn(`MPU abort failed for key=${key}, uploadId=${uploadId}: ${String(e)}`)
  }
  return new Response(null, { status: 204 })
}

// POST /mpu/complete?name=<name>&key=<key>&uploadId=<uploadId>
// formdata same as POST/PUT a normal paste, but
//   - field `c` is interpreted as JSON { partNumber: number, etag: string }[]
//   - field `n` is ignored
export function parseMPUCompleteIdentity(request: Request): { uploadId: string; key: string; name: string } {
  const url = new URL(request.url)
  const identity = requireSearchParams(url, ["uploadId", "key", "name"] as const, "no uploadId or key for MPU complete")
  if (identity.name !== pasteNameFromObjectKey(identity.key)) {
    throw new WorkerError(400, `name ‘${identity.name}’ is not consistent with the originally specified name`)
  }
  return identity
}

export async function handleMPUComplete(
  env: Env,
  { uploadId, key }: ReturnType<typeof parseMPUCompleteIdentity>,
  completeBody: R2UploadedPart[],
): Promise<R2Object> {
  const multipartUpload = env.R2.resumeMultipartUpload(key, uploadId)

  let object: R2Object
  try {
    object = await multipartUpload.complete(completeBody)
  } catch (e) {
    console.warn(`MPU complete failed for key=${key}, uploadId=${uploadId}: ${String(e)}`)
    throw new WorkerError(410, "multipart upload no longer exists; please retry from /mpu/create")
  }
  if (object.size > parseSize(env.R2_MAX_ALLOWED)!) {
    // Best-effort cleanup; if delete fails we still want the 413 to reach the user.
    try {
      await env.R2.delete(object.key)
    } catch (e) {
      console.warn(`failed to delete oversized MPU object '${object.key}': ${String(e)}`)
    }
    throw new WorkerError(413, `payload too large (max ${env.R2_MAX_ALLOWED} allowed)`)
  }
  return object
}
