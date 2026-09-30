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
import { asArrayBufferView } from "../../shared/bytes.js"
import { StreamedFileCollector } from "./streamedOutput.js"
import { FileOutputSink } from "./fileOutput.js"

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
  output?: Pick<FileOutputSink, "finish" | "abort">
}

async function finishResponseFile(
  lifecycle: ResponseBodyLifecycle,
  options: ResponseDownloadOptions,
): Promise<DownloadedResponseFile> {
  options.signal?.throwIfAborted()
  const completed = await lifecycle.output!.finish(options.filename, options.type)
  options.signal?.throwIfAborted()
  const includeContent = options.includeContent ?? !completed.cleanup
  const content = includeContent ? new Uint8Array(await completed.file.arrayBuffer()) : undefined
  options.signal?.throwIfAborted()
  return { ...completed, content }
}

async function consumeResponseReader<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (lifecycle: ResponseBodyLifecycle) => Promise<T>,
): Promise<T> {
  const lifecycle: ResponseBodyLifecycle = {}
  try {
    return await consume(lifecycle)
  } catch (error) {
    await lifecycle.output?.abort()
    // Cancelling one side of a tee can wait for the other consumer indefinitely.
    // Start cancellation, then release our lock and report the original error promptly.
    void reader.cancel(error).catch(() => undefined)
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
  const threshold = options.opfsThreshold ?? OPFS_DOWNLOAD_THRESHOLD
  const useOPFS = expectedSize !== null && expectedSize >= threshold

  // Unknown-size bodies use the same spill and fallback policy as APNG exports.
  if (expectedSize === null && Number.isFinite(threshold) && response.body) {
    const reader = response.body.getReader()
    return await consumeResponseReader(reader, async (lifecycle) => {
      const output = new StreamedFileCollector({ thresholdBytes: threshold })
      lifecycle.output = output
      while (true) {
        options.signal?.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        await output.append([asArrayBufferView(next.value)])
      }
      return await finishResponseFile(lifecycle, options)
    })
  }

  if (!useOPFS) {
    options.signal?.throwIfAborted()
    if (options.includeContent === false) {
      const blob = await response.blob()
      options.signal?.throwIfAborted()
      if (expectedSize !== null && blob.size !== expectedSize) {
        throw new Error("Downloaded response size does not match Content-Length")
      }
      return { file: new File([blob], options.filename, { type: options.type }) }
    }
    const content = await response.bytes()
    options.signal?.throwIfAborted()
    if (expectedSize !== null && content.byteLength !== expectedSize) {
      throw new Error("Downloaded response size does not match Content-Length")
    }
    const file = new File([content as BlobPart], options.filename, { type: options.type })
    return { file, content }
  }

  if (!response.body) throw new Error("The download response does not have a readable body")
  const reader = response.body.getReader()
  return await consumeResponseReader(reader, async (lifecycle) => {
    options.signal?.throwIfAborted()
    const output = new FileOutputSink(await createOPFSTemporaryFile(expectedSize))
    lifecycle.output = output
    let written = 0
    while (true) {
      options.signal?.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      if (written + next.value.byteLength > expectedSize) {
        throw new Error("Downloaded response is larger than Content-Length")
      }
      await output.write(asArrayBufferView(next.value))
      written += next.value.byteLength
    }
    if (written !== expectedSize) throw new Error("Downloaded response ended before Content-Length")

    return await finishResponseFile(lifecycle, options)
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

type DecryptResponseOptions = Omit<ResponseDownloadOptions, "expectedSize">

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
    const output = new FileOutputSink(useOPFS ? await createOPFSTemporaryFile(header.plaintextSize) : undefined)
    lifecycle.output = output
    const session = createChunkedDecryptionSession(key, headerBytes)
    try {
      for (let index = 0; index < encryptionChunkCount(header.plaintextSize); index += 1) {
        options.signal?.throwIfAborted()
        const { start, end } = encryptionChunkBounds(header.plaintextSize, index)
        const encrypted = await exact.read(end - start + ENCRYPTION_TAG_SIZE)
        const decrypted = await session.decrypt(index, encrypted.buffer)
        options.signal?.throwIfAborted()
        await output.write(decrypted)
      }
    } finally {
      session.close()
    }
    await exact.ensureEnd()

    return await finishResponseFile(lifecycle, options)
  })
}
