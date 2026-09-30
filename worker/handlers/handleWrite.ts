import { verifyAuth } from "../pages/auth.js"
import { genRandStr, jsonResponse, WorkerError } from "../common.js"
import { assertPastePassword, requirePasteMetadata } from "../pasteAccess.js"
import {
  createPaste,
  allocateRandomPasteName,
  metaResponseFromMetadata,
  updatePaste,
  type PasteMetadata,
} from "../storage/storage.js"
import {
  BINARY_MIME_TYPE,
  DEFAULT_PASSWD_LEN,
  DIRECT_UPLOAD_MAX_BYTES,
  PASTE_NAME_LEN,
  PRIVATE_PASTE_NAME_LEN,
  PASSWD_SEP,
  TEXT_MIME_TYPE,
} from "../../shared/constants.js"
import { parsePath, parseExpiration, parseSize } from "../../shared/parsers.js"
import { isOriginalFileInfo, parseReadLimit, verifyPassword } from "../../shared/verify.js"
import type { OriginalFileInfo, PasteResponse } from "../../shared/interfaces.js"
import {
  handleMPUAbort,
  handleMPUComplete,
  handleMPUCreate,
  handleMPUCreateUpdate,
  handleMPUResume,
  parseMPUCompleteIdentity,
} from "./handleMPU.js"

function parseOriginalFileInfos(raw: string | undefined): OriginalFileInfo[] | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new WorkerError(400, "invalid filenames metadata")
  }
  if (!Array.isArray(parsed)) {
    throw new WorkerError(400, "invalid filenames metadata")
  }
  return parsed.map((item) => {
    if (!isOriginalFileInfo(item)) {
      throw new WorkerError(400, "invalid filenames metadata")
    }
    return { name: item.name, sizeBytes: item.sizeBytes }
  })
}

function parseMimeType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (raw === TEXT_MIME_TYPE || raw === BINARY_MIME_TYPE) return raw
  throw new WorkerError(400, "invalid mimeType metadata")
}

function parseRemainingReads(raw: string | undefined, defaultReads: number): number | undefined {
  const remainingReads = parseReadLimit(raw === undefined ? defaultReads : raw)
  if (remainingReads === null) {
    throw new WorkerError(400, "invalid reads limit")
  }
  return remainingReads === 0 ? undefined : remainingReads
}

function parseUploadedParts(raw: string | undefined): R2UploadedPart[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? "")
  } catch {
    throw new WorkerError(400, "invalid uploaded parts")
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new WorkerError(400, "invalid uploaded parts")
  }
  const parts: unknown[] = parsed
  if (
    parts.some((part) => {
      if (typeof part !== "object" || part === null) return true
      const entry = part as Record<string, unknown>
      return (
        typeof entry.partNumber !== "number" ||
        !Number.isSafeInteger(entry.partNumber) ||
        entry.partNumber < 1 ||
        typeof entry.etag !== "string" ||
        entry.etag.length === 0
      )
    })
  ) {
    throw new WorkerError(400, "invalid uploaded parts")
  }
  return parts as R2UploadedPart[]
}

const FORM_METADATA_ALLOWANCE_BYTES = 1024 * 1024
const MPU_COMPLETE_MAX_PART_BYTES = 1024 * 1024

async function parseUploadForm(req: Request, maxPartSize: number, sizeLimitLabel: string): Promise<FormData> {
  // Include boundaries, headers and metadata without reducing the advertised
  // content limit. Count actual bytes even when Content-Length is absent/wrong.
  const maxBodySize = maxPartSize + FORM_METADATA_ALLOWANCE_BYTES
  const tooLarge = () => new WorkerError(413, "multipart request body is too large")
  if (Number(req.headers.get("Content-Length")) > maxBodySize) {
    void req.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  const reader = req.body?.getReader()
  let exceeded = false
  let received = 0
  const body = reader
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) {
              controller.close()
              return
            }
            received += next.value.byteLength
            if (received > maxBodySize) {
              exceeded = true
              controller.error(tooLarge())
              void reader.cancel().catch(() => undefined)
              return
            }
            controller.enqueue(next.value)
          } catch (error) {
            controller.error(error)
          }
        },
        cancel: (reason: unknown) => reader.cancel(reason),
      })
    : null
  let formData: FormData
  try {
    formData = await new Response(body, { headers: { "Content-Type": req.headers.get("Content-Type")! } }).formData()
  } catch (err) {
    if (exceeded) throw tooLarge()
    console.warn("Failed to parse multipart request:", err instanceof Error ? err.message : err)
    throw new WorkerError(400, "Failed to parse multipart request")
  } finally {
    if (reader) {
      // Also stop unread input when the multipart parser rejects early.
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  for (const value of formData.values()) {
    const size = typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.size
    if (size > maxPartSize) throw new WorkerError(413, `payload too large (max ${sizeLimitLabel} allowed)`)
  }
  return formData
}

// Preserve the existing last-field-wins behavior, including file-valued metadata.
function lastFormValue(form: FormData, name: string): FormDataEntryValue | undefined {
  const values = form.getAll(name)
  return values[values.length - 1]
}

async function formText(form: FormData, name: string): Promise<string | undefined> {
  const value = lastFormValue(form, name)
  return typeof value === "string" ? value : value?.text()
}

export async function handlePostOrPut(
  request: Request,
  env: Env,
  _: ExecutionContext,
  isPut: boolean,
): Promise<Response> {
  if (!isPut) {
    // only POST requires auth, since PUT request already contains auth
    const authResponse = await verifyAuth(request, env)
    if (authResponse !== null) {
      return authResponse
    }
  }

  const url = new URL(request.url)

  let isMPUComplete = false
  if (url.pathname === "/mpu/create" && !isPut) {
    return await handleMPUCreate(request, env)
  } else if (url.pathname === "/mpu/create-update" && !isPut) {
    return await handleMPUCreateUpdate(request, env)
  } else if (url.pathname === "/mpu/resume" && isPut) {
    return await handleMPUResume(request, env)
  } else if (url.pathname === "/mpu/abort" && !isPut) {
    return await handleMPUAbort(request, env)
  } else if (url.pathname === "/mpu/complete") {
    isMPUComplete = true // we will handle mpu complete later since it is uploaded with formdata
  } else if (url.pathname.startsWith("/mpu/")) {
    throw new WorkerError(400, "illegal mpu operation")
  }

  const contentType = request.headers.get("Content-Type") || ""

  // parse formdata
  if (!contentType.includes("multipart/form-data")) {
    throw new WorkerError(400, `bad usage, please use 'multipart/form-data' instead of ${contentType}`)
  }

  const parts = isMPUComplete
    ? await parseUploadForm(request, MPU_COMPLETE_MAX_PART_BYTES, "1 MiB")
    : await parseUploadForm(request, DIRECT_UPLOAD_MAX_BYTES, "5 MiB")

  if (!parts.has("c")) {
    throw new WorkerError(400, "cannot find content in formdata")
  }
  const part = lastFormValue(parts, "c")!
  const filename = typeof part === "string" ? undefined : part.name
  const content = isMPUComplete
    ? new ArrayBuffer(0)
    : typeof part === "string"
      ? new TextEncoder().encode(part).buffer
      : part.stream()
  const contentLength = content instanceof ArrayBuffer ? content.byteLength : (part as File).size
  if (!isMPUComplete && contentLength > parseSize(env.R2_MAX_ALLOWED)!) {
    throw new WorkerError(413, `payload too large (max ${env.R2_MAX_ALLOWED} allowed)`)
  }
  const isPrivate = parts.has("p")
  const passwdFromForm = await formText(parts, "s")
  const expireFromForm = await formText(parts, "e")
  const encryptionScheme = await formText(parts, "encryption-scheme")
  const highlightLanguage = await formText(parts, "lang")
  const filenames = parseOriginalFileInfos(await formText(parts, "filenames"))
  const mimeType = parseMimeType(await formText(parts, "mimeType"))
  const remainingReads = parseRemainingReads(await formText(parts, "reads"), env.DEFAULT_READS)
  const expire = expireFromForm || env.DEFAULT_EXPIRATION

  // parse expiration
  let expirationSeconds = parseExpiration(expire)
  if (expirationSeconds === null) {
    throw new WorkerError(400, `‘${expire}’ is not a valid expiration specification`)
  }
  const maxExpiration = parseExpiration(env.MAX_EXPIRATION)!
  if (expirationSeconds > maxExpiration) {
    expirationSeconds = maxExpiration
  }

  // check if password is legal
  if (passwdFromForm) {
    const [ok, msg] = verifyPassword(passwdFromForm)
    if (!ok) throw new WorkerError(400, msg)
  }

  let pasteName: string
  let password: string | undefined
  if (isMPUComplete) {
    const name = url.searchParams.get("name")
    if (name === null || (isPut && name === "")) throw new WorkerError(400, "no name for MPU complete")
    pasteName = name
  } else if (isPut) {
    const parsed = parsePath(url.pathname)
    if (parsed.password === undefined) throw new WorkerError(403, "no password for PUT request")
    pasteName = parsed.name
    password = parsed.password
  } else {
    pasteName = await allocateRandomPasteName(env, isPrivate ? PRIVATE_PASTE_NAME_LEN : PASTE_NAME_LEN)
  }

  let originalMetadata: PasteMetadata | undefined
  if (isPut) {
    const metadata = await requirePasteMetadata(env, pasteName)
    // MPU updates were authorized when their upload was created.
    if (!isMPUComplete) assertPastePassword(pasteName, password, metadata)
    originalMetadata = metadata
  }
  const mpuIdentity = isMPUComplete ? parseMPUCompleteIdentity(request) : undefined
  const uploadedParts = mpuIdentity ? parseUploadedParts(await formText(parts, "c")) : undefined
  const r2Object = mpuIdentity ? await handleMPUComplete(env, mpuIdentity, uploadedParts!) : undefined

  const passwd = passwdFromForm || originalMetadata?.passwd || genRandStr(DEFAULT_PASSWD_LEN)
  const options = {
    expirationSeconds,
    now: new Date(),
    passwd,
    filename,
    filenames,
    mimeType,
    highlightLanguage,
    contentLength: r2Object?.size ?? contentLength,
    encryptionScheme,
    remainingReads,
    isMPUComplete,
    r2Key: r2Object?.key,
  }
  const metadata = originalMetadata
    ? await updatePaste(env, pasteName, content, originalMetadata, options)
    : await createPaste(env, pasteName, content, options)
  const response: PasteResponse = {
    ...metaResponseFromMetadata(metadata),
    url: env.DEPLOY_URL + "/" + pasteName,
    manageUrl: env.DEPLOY_URL + "/" + pasteName + PASSWD_SEP + passwd,
    expirationSeconds,
  }
  return jsonResponse(response, { headers: r2Object ? { etag: r2Object.httpEtag } : undefined }, 2)
}
