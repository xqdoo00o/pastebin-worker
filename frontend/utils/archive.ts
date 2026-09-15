import { itemNoun } from "../../shared/format.js"
import { ZIP_MEMORY_THRESHOLD_BYTES } from "../../shared/constants.js"
import type { ArchiveCompression, ArchiveWorkerRequest, ArchiveWorkerResponse } from "./archiveCore.js"
import { buildManagedOutput, type OutputChunkWriter } from "./managedOutput.js"
import type { ManagedFile } from "./opfs.js"
import { isPrecompressedFile } from "./precompressed.js"
import { abortReason, asError } from "./errors.js"

const estimatedArchiveEntryOverhead = 1024

export type PreparedArchive = ManagedFile

export interface ZipFilesOptions {
  signal?: AbortSignal
  opfsThreshold?: number
  /** How compressible files are packed into the ZIP: deflate (default) or zstd. */
  compression?: ArchiveCompression
}

export function estimateArchiveSize(files: File[]): number {
  let estimatedSize = 0
  for (const file of files) {
    const nextSize = estimatedSize + file.size + estimatedArchiveEntryOverhead
    if (!Number.isSafeInteger(nextSize)) return Number.MAX_SAFE_INTEGER
    estimatedSize = nextSize
  }
  return estimatedSize
}

function zipFilenameDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function supportsNativeCompressionStream(): boolean {
  try {
    // zip.js can turn a native gzip stream into the raw DEFLATE stream used
    // by ZIP entries, including on browsers without `deflate-raw` support.
    new CompressionStream("gzip")
    return true
  } catch {
    return false
  }
}

function createArchiveWorker(): Worker {
  return new Worker(new URL("./archive.worker.ts", import.meta.url), { type: "module" })
}

async function streamZipFilesInWorker(
  worker: Worker,
  files: File[],
  writeChunk: (chunk: Uint8Array) => Promise<void>,
  compression: ArchiveCompression,
  useFflateWorker: boolean,
  signal?: AbortSignal,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const handleAbort = () => finish(abortReason(signal!))

    worker.onmessage = (event: MessageEvent<ArchiveWorkerResponse>) => {
      const message = event.data
      if (message.type === "error") {
        const error = new Error(message.error.message)
        error.name = message.error.name
        finish(error)
        return
      }
      if (message.type === "complete") {
        finish()
        return
      }

      void (async () => {
        try {
          signal?.throwIfAborted()
          await writeChunk(new Uint8Array(message.data))
          signal?.throwIfAborted()
          if (settled) return
          const ack: ArchiveWorkerRequest = { type: "chunk-ack", id: message.id }
          worker.postMessage(ack)
        } catch (error) {
          finish(asError(error))
        }
      })()
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(event.error instanceof Error ? event.error : new Error(event.message || "Archive worker failed"))
    }
    worker.onmessageerror = () => finish(new Error("Archive worker returned an invalid message"))
    signal?.addEventListener("abort", handleAbort, { once: true })

    if (signal?.aborted) {
      handleAbort()
      return
    }

    void (async () => {
      try {
        // Compile once in the page and share the Module with the worker, like
        // the optical codecs, so the worker never fetches or recompiles it.
        if (compression === "zstd") {
          const { loadZstdEncoderWasmModule } = await import("../wasm/zstd-loader.js")
          const zstdEncoderWasmModule = await loadZstdEncoderWasmModule(estimateArchiveSize(files))
          worker.postMessage({ type: "init", zstdEncoderWasmModule })
        }
        const request: ArchiveWorkerRequest = { type: "start", files, compression, useFflateWorker }
        worker.postMessage(request)
      } catch (error) {
        finish(asError(error))
      }
    })()
  })
}

async function produceArchive(
  files: File[],
  compression: ArchiveCompression,
  signal: AbortSignal | undefined,
  writeChunk: OutputChunkWriter,
): Promise<void> {
  const needsDeflate = compression === "deflate" && files.some((file) => !isPrecompressedFile(file))
  const useFflateWorker = needsDeflate && !supportsNativeCompressionStream()
  const archiveWorker = createArchiveWorker()
  await streamZipFilesInWorker(archiveWorker, files, writeChunk, compression, useFflateWorker, signal)
}

export async function zipFiles(
  files: File[],
  { signal, opfsThreshold = ZIP_MEMORY_THRESHOLD_BYTES, compression = "deflate" }: ZipFilesOptions = {},
): Promise<PreparedArchive> {
  signal?.throwIfAborted()
  const filename = `${files.length}-${itemNoun(files.length)}-${zipFilenameDate()}.zip`
  const estimatedSize = estimateArchiveSize(files)
  return await buildManagedOutput({
    filename,
    mediaType: "application/zip",
    expectedSize: estimatedSize,
    opfsThreshold,
    purpose: "archive",
    signal,
    produce: (writeChunk) => produceArchive(files, compression, signal, writeChunk),
  })
}
