import {
  configure,
  registerCodec,
  Reader,
  ZipWriter,
  type CompressionStreamOptions,
} from "@zip.js/zip.js/lib/zip-core-custom.js"
import { STREAMING_COMPRESSION_CHUNK_BYTES } from "../../shared/constants.js"
import { dedupeFilename } from "../../shared/fileType.js"
import { createStreamingZstdCompressor, ZSTD_LEVEL } from "../wasm/zstd-runtime.js"
import { fileByteSource, type RandomAccessByteSource } from "./byteSource.js"
import { isPrecompressedFile } from "./precompressed.js"

export type ArchiveCompression = "deflate" | "zstd"

interface ArchiveWorkerStartRequest {
  type: "start"
  files: File[]
  compression: ArchiveCompression
  useFflateWorker: boolean
}

interface ArchiveWorkerInitRequest {
  type: "init"
  zstdEncoderWasmModule?: WebAssembly.Module
}

interface ArchiveWorkerChunkAckRequest {
  type: "chunk-ack"
  id: number
}

export type ArchiveWorkerRequest = ArchiveWorkerStartRequest | ArchiveWorkerInitRequest | ArchiveWorkerChunkAckRequest

interface ArchiveWorkerChunkResponse {
  type: "chunk"
  id: number
  data: ArrayBuffer
}

interface ArchiveWorkerCompleteResponse {
  type: "complete"
}

interface ArchiveWorkerErrorResponse {
  type: "error"
  error: {
    name: string
    message: string
  }
}

export type ArchiveWorkerResponse =
  ArchiveWorkerChunkResponse | ArchiveWorkerCompleteResponse | ArchiveWorkerErrorResponse

/** Zip compression method IDs: 0 = store, 8 = deflate, 93 = zstd. */
const ZIP_DEFLATE_METHOD = 8
const ZIP_ZSTD_METHOD = 93
/** Deflate level matching the native CompressionStream's de facto level. */
const ZIP_DEFLATE_LEVEL = 6
const COMPRESSIBLE_CODECS: Record<ArchiveCompression, { method: number; level: number }> = {
  deflate: { method: ZIP_DEFLATE_METHOD, level: ZIP_DEFLATE_LEVEL },
  zstd: { method: ZIP_ZSTD_METHOD, level: ZSTD_LEVEL },
}

// Keep native and registered codecs in the current archive realm. The per-entry
// override enables the custom fflate codec worker only for the legacy fallback.
configure({
  useWebWorkers: false,
  chunkSize: STREAMING_COMPRESSION_CHUNK_BYTES,
  createWorker: () => new Worker(new URL("./zip-fflate.worker.ts", import.meta.url), { type: "module" }),
})

export class ZstdCompressionStream {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>

  constructor(_format: string, options?: CompressionStreamOptions) {
    let compressorPromise: ReturnType<typeof createStreamingZstdCompressor> | undefined
    let compressor: Awaited<ReturnType<typeof createStreamingZstdCompressor>> | undefined
    let disposed = false

    const getCompressor = async () => {
      if (disposed) throw new Error("The zstd compression stream is closed.")
      compressorPromise ??= createStreamingZstdCompressor({
        level: options?.level,
        pledgedSize: options?.uncompressedSize,
      })
      return (compressor ??= await compressorPromise)
    }

    const dispose = async () => {
      if (disposed) return
      disposed = true
      if (!compressor && compressorPromise) {
        try {
          compressor = await compressorPromise
        } catch {
          return
        }
      }
      compressor?.free()
      compressor = undefined
    }

    // zip.js creates one CompressionStream per entry. Keep one zstd context for
    // that entry so all 4 MiB input chunks share history and form one frame.
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        const output = (await getCompressor()).push(chunk)
        if (output.byteLength !== 0) controller.enqueue(output)
      },
      async flush(controller) {
        try {
          const output = (await getCompressor()).finish()
          if (output.byteLength !== 0) controller.enqueue(output)
        } finally {
          await dispose()
        }
      },
    })
    this.readable = transform.readable
    const writer = transform.writable.getWriter()
    this.writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        try {
          await writer.write(chunk)
        } catch (error) {
          await dispose()
          throw error
        }
      },
      async close() {
        try {
          await writer.close()
        } finally {
          await dispose()
        }
      },
      async abort(reason) {
        try {
          await writer.abort(reason)
        } finally {
          await dispose()
        }
      },
    })
  }
}

let zstdCodecRegistered = false

function ensureZstdCodecRegistered(): void {
  if (zstdCodecRegistered) return
  zstdCodecRegistered = true
  registerCodec({
    compressionMethod: ZIP_ZSTD_METHOD,
    format: "zstd",
    versionNeeded: 63,
    CompressionStream: ZstdCompressionStream,
  })
}

interface StreamZipFilesOptions {
  compression: ArchiveCompression
  signal?: AbortSignal
  useWebWorkers?: boolean
}

function zipEntryName(file: File, existing: Set<string>): string {
  const name = dedupeFilename(file.name, (candidate) => existing.has(candidate))
  existing.add(name)
  return name
}

export async function streamZipFiles(
  files: File[],
  writeChunk: (chunk: Uint8Array) => Promise<void>,
  { compression, signal, useWebWorkers = false }: StreamZipFilesOptions,
): Promise<void> {
  const codec = COMPRESSIBLE_CODECS[compression]
  if (compression === "zstd") ensureZstdCodecRegistered()

  // A WritableStream whose writes go through writeChunk gives zip.js the same
  // backpressure as the previous callback-based archive: the archive pauses
  // until the caller (worker ack or OPFS write) has consumed each chunk.
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      signal?.throwIfAborted()
      await writeChunk(chunk)
    },
  })
  // Keep bufferedWrite disabled so compressed bytes flow through writable as
  // they are produced. ZIP data descriptors are standard and avoid retaining
  // an entire compressed entry in memory just to rewrite its local header.
  const zipWriter = new ZipWriter(writable)
  const names = new Set<string>()
  for (const file of files) {
    signal?.throwIfAborted()
    const store = isPrecompressedFile(file)
    // lastModDate mirrors the demo (zip.FS adds files with
    // `lastModDate: new Date(file.lastModified)`); without it zip.js stamps
    // every entry with the packing time instead of the source file's own
    // modification time. Some File-likes omit lastModified; skip the option
    // then so zip.js falls back to its default instead of an Invalid Date.
    await zipWriter.add(zipEntryName(file, names), new FileSliceReader(file), {
      compressionMethod: store ? 0 : codec.method,
      level: store ? 0 : codec.level,
      useWebWorkers: !store && useWebWorkers,
      lastModDate: Number.isFinite(file.lastModified) ? new Date(file.lastModified) : undefined,
    })
  }
  await zipWriter.close()
  signal?.throwIfAborted()
}

/**
 * Size-aware file reader for zip.js. The content streams in
 * 4 MiB slices (one continuous compression stream per entry).
 * It deliberately extends the base `Reader` (not
 * `BlobReader`): `BlobReader` reads the whole blob via `Blob.stream()`, which
 * is unavailable in some environments (e.g. jsdom), so reads go through
 * `slice().arrayBuffer()`.
 */
class FileSliceReader extends Reader<File> {
  private readonly source: RandomAccessByteSource

  constructor(file: File) {
    // Reader's TS declaration requires the value even though the base class
    // ignores it at runtime.
    super(file)
    this.source = fileByteSource(file)
    this.size = this.source.size
  }

  async readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    return await this.source.read(offset, offset + length)
  }
}
