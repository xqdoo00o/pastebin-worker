import type { EncryptionScheme } from "../../shared/constants.js"
import { createChunkedDecryptionSession, decodeKey } from "./encryption.js"
import {
  CHUNKED_ENCRYPTION_SCHEME,
  encryptedFileSize,
  encryptionChunkBounds,
  encryptionChunkCount,
  ENCRYPTION_HEADER_SIZE,
  ENCRYPTION_TAG_SIZE,
  parseEncryptionHeader,
} from "./encryptionCore.js"
import { createOPFSTemporaryFile, OPFS_DOWNLOAD_THRESHOLD, type ManagedFile } from "./opfs.js"
import { parseNonNegativeSafeInteger } from "../../shared/numbers.js"

export interface DownloadedResponseFile extends ManagedFile {
  content?: Uint8Array
}

interface ResponseDownloadOptions {
  filename: string
  type: string
  includeContent?: boolean
  expectedSize?: number
  opfsThreshold?: number
  signal?: AbortSignal
}

function parseSize(value: string | null | number | undefined): number | null {
  return parseNonNegativeSafeInteger(value)
}

interface ResponseBodyLifecycle {
  temporaryFile?: Awaited<ReturnType<typeof createOPFSTemporaryFile>>
  cleanup?: () => Promise<void>
}

async function consumeResponseReader<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (lifecycle: ResponseBodyLifecycle) => Promise<T>,
): Promise<T> {
  const lifecycle: ResponseBodyLifecycle = {}
  try {
    return await consume(lifecycle)
  } catch (error) {
    await lifecycle.temporaryFile?.abort()
    await lifecycle.cleanup?.()
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function downloadResponseToFile(
  response: Response,
  options: ResponseDownloadOptions,
): Promise<DownloadedResponseFile> {
  const declaredSize = parseSize(response.headers.get("Content-Length"))
  const expectedSize = declaredSize ?? parseSize(options.expectedSize)
  const useOPFS = expectedSize !== null && expectedSize >= (options.opfsThreshold ?? OPFS_DOWNLOAD_THRESHOLD)

  if (!useOPFS) {
    options.signal?.throwIfAborted()
    const content = await response.bytes()
    options.signal?.throwIfAborted()
    if (expectedSize !== null && content.byteLength !== expectedSize) {
      throw new Error("Downloaded response size does not match Content-Length")
    }
    const file = new File([content as BlobPart], options.filename, { type: options.type })
    return options.includeContent === false ? { file } : { file, content }
  }

  if (!response.body) throw new Error("The download response does not have a readable body")
  const reader = response.body.getReader()
  return await consumeResponseReader(reader, async (lifecycle) => {
    options.signal?.throwIfAborted()
    lifecycle.temporaryFile = await createOPFSTemporaryFile(expectedSize)
    let written = 0
    while (true) {
      options.signal?.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      if (written + next.value.byteLength > expectedSize) {
        throw new Error("Downloaded response is larger than Content-Length")
      }
      await lifecycle.temporaryFile.write(next.value)
      written += next.value.byteLength
    }
    if (written !== expectedSize) throw new Error("Downloaded response ended before Content-Length")

    const completed = await lifecycle.temporaryFile.finish(options.filename, options.type)
    lifecycle.cleanup = completed.cleanup
    lifecycle.temporaryFile = undefined
    const content = options.includeContent ? new Uint8Array(await completed.file.arrayBuffer()) : undefined
    return { file: completed.file, content, cleanup: lifecycle.cleanup, deferCleanup: completed.deferCleanup }
  })
}

class ExactStreamReader {
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private offset = 0
  private ended = false

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(size: number): Promise<Uint8Array<ArrayBuffer>> {
    const result = new Uint8Array(size)
    let written = 0
    while (written < size) {
      if (this.offset >= this.current.byteLength) {
        const next = await this.reader.read()
        if (next.done) {
          this.ended = true
          throw new Error("Encrypted response ended before the declared file size")
        }
        this.current = next.value
        this.offset = 0
      }
      const available = this.current.byteLength - this.offset
      const take = Math.min(available, size - written)
      result.set(this.current.subarray(this.offset, this.offset + take), written)
      this.offset += take
      written += take
    }
    return result
  }

  async ensureEnd(): Promise<void> {
    if (this.offset < this.current.byteLength) throw new Error("Encrypted response contains trailing data")
    if (this.ended) return
    const next = await this.reader.read()
    if (!next.done) throw new Error("Encrypted response contains trailing data")
    this.ended = true
  }
}

interface DecryptResponseOptions {
  filename: string
  type: string
  includeContent?: boolean
  opfsThreshold?: number
  signal?: AbortSignal
}

export async function decryptResponseToFile(
  response: Response,
  scheme: EncryptionScheme,
  encodedKey: string,
  options: DecryptResponseOptions,
): Promise<DownloadedResponseFile> {
  if (scheme !== CHUNKED_ENCRYPTION_SCHEME) throw new Error(`Unsupported encryption scheme: ${scheme as string}`)
  if (!response.body) throw new Error("The encrypted response does not have a readable body")

  const key = await decodeKey(scheme, encodedKey)
  const reader = response.body.getReader()
  const exact = new ExactStreamReader(reader)
  return await consumeResponseReader(reader, async (lifecycle) => {
    options.signal?.throwIfAborted()
    const headerBytes = await exact.read(ENCRYPTION_HEADER_SIZE)
    const header = parseEncryptionHeader(headerBytes)
    const contentLength = response.headers.get("Content-Length")
    const declaredCiphertextSize = contentLength === null ? null : Number(contentLength)
    if (
      declaredCiphertextSize !== null &&
      Number.isFinite(declaredCiphertextSize) &&
      declaredCiphertextSize !== encryptedFileSize(header.plaintextSize)
    ) {
      throw new Error("Encrypted response size does not match its header")
    }

    const useOPFS = header.plaintextSize >= (options.opfsThreshold ?? OPFS_DOWNLOAD_THRESHOLD)
    const content = useOPFS ? undefined : new Uint8Array(header.plaintextSize)
    if (useOPFS) lifecycle.temporaryFile = await createOPFSTemporaryFile(header.plaintextSize)
    const session = createChunkedDecryptionSession(key, headerBytes)
    try {
      for (let index = 0; index < encryptionChunkCount(header.plaintextSize); index += 1) {
        options.signal?.throwIfAborted()
        const { start, end } = encryptionChunkBounds(header.plaintextSize, index)
        const encrypted = await exact.read(end - start + ENCRYPTION_TAG_SIZE)
        const decrypted = await session.decrypt(index, encrypted.buffer)
        options.signal?.throwIfAborted()
        if (lifecycle.temporaryFile) await lifecycle.temporaryFile.write(decrypted)
        else content!.set(new Uint8Array(decrypted), start)
      }
    } finally {
      session.close()
    }
    await exact.ensureEnd()

    if (lifecycle.temporaryFile) {
      const completed = await lifecycle.temporaryFile.finish(options.filename, options.type)
      lifecycle.cleanup = completed.cleanup
      lifecycle.temporaryFile = undefined
      const includedContent = options.includeContent ? new Uint8Array(await completed.file.arrayBuffer()) : undefined
      return {
        file: completed.file,
        content: includedContent,
        cleanup: lifecycle.cleanup,
        deferCleanup: completed.deferCleanup,
      }
    }

    const file = new File([content!], options.filename, { type: options.type })
    return options.includeContent === false ? { file } : { file, content }
  })
}
