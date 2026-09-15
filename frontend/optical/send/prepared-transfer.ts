import {
  OPFS_LARGE_FILE_THRESHOLD_BYTES,
  STREAMING_COMPRESSION_CHUNK_BYTES,
  STREAMING_FILE_READ_CHUNK_BYTES,
} from "../../../shared/constants.js"
import { createStreamingZstdCompressor } from "../../wasm/zstd-runtime.js"
import { createStreamingXXH3, xxh3Chunks } from "../../wasm/xxhash-runtime.js"
import {
  arrayBufferByteSource,
  blobByteSource,
  fileByteSource,
  readByteSourceChunks,
  type RandomAccessByteSource,
} from "../../utils/byteSource.js"
import { buildManagedOutput } from "../../utils/managedOutput.js"
import {
  compressedPartPayloadLimit,
  isOpticalCompressionCandidate,
  MAX_FILE_BYTES,
  MAX_PART_COUNT,
  MAX_TRANSFER_BYTES,
  opticalContainerSize,
  packTransferPayloadFromSource,
  type CompressionMode,
  type PackedOpticalFile,
} from "../shared/protocol.js"
import type { PreparedOpticalFile } from "../shared/worker-messages.js"

export interface OpticalMemoryFile {
  name: string
  type: string
  data: ArrayBuffer
}

interface StoredCompressedPayload {
  source: RandomAccessByteSource
  sourceHash: bigint
  cleanup?: () => Promise<void>
}

export interface PreparedOpticalTransfer {
  readonly summary: PreparedOpticalFile
  getPart(index: number, signal?: AbortSignal): Promise<PackedOpticalFile>
  cleanup(): Promise<void>
}

export interface PrepareOpticalTransferOptions {
  signal?: AbortSignal
  /** Media type serialized into DCF5; permits presentation metadata without
   * wrapping a potentially large disk-backed File. */
  mediaType?: string
  /** Overrideable for protocol tests; production uses the 64 MiB wire limit. */
  partPayloadSize?: number
  /** Source-size threshold above which compressed output is written to OPFS. */
  opfsThreshold?: number
}

async function compressFile(
  source: RandomAccessByteSource,
  compressedName: string,
  opfsThreshold: number,
  allowOPFS: boolean,
  signal?: AbortSignal,
): Promise<StoredCompressedPayload> {
  let sourceHash: bigint | undefined
  const produce = async (writeChunk: (chunk: Uint8Array) => Promise<void>): Promise<void> => {
    const compressor = await createStreamingZstdCompressor({ pledgedSize: source.size })
    try {
      const hasher = await createStreamingXXH3()
      try {
        for await (const input of readByteSourceChunks(source, STREAMING_COMPRESSION_CHUNK_BYTES, signal)) {
          hasher.update(input)
          await writeChunk(compressor.push(input))
        }
        await writeChunk(compressor.finish())
        sourceHash = hasher.digest()
      } finally {
        hasher.free()
      }
    } finally {
      compressor.free()
    }
  }

  // A standalone sender already owns a transferred ArrayBuffer. Keep its
  // compressed result in JS memory too: Safari cannot reliably read a File
  // created inside a blob/null-origin worker.
  if (!allowOPFS) {
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let length = 0
    await produce((chunk) => {
      if (chunk.byteLength === 0) return Promise.resolve()
      const stable = chunk.slice()
      chunks.push(stable)
      length += stable.byteLength
      return Promise.resolve()
    })
    if (sourceHash === undefined) throw new Error("The optical source hash was not completed.")
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { source: arrayBufferByteSource(bytes.buffer), sourceHash }
  }

  const completed = await buildManagedOutput({
    filename: compressedName,
    mediaType: "application/zstd",
    expectedSize: source.size,
    opfsThreshold,
    purpose: "optical",
    signal,
    produce,
  })
  if (sourceHash === undefined) {
    await completed.cleanup?.()
    throw new Error("The optical source hash was not completed.")
  }
  return { source: blobByteSource(completed.file), sourceHash, cleanup: completed.cleanup }
}

async function wholeFileTransferId(source: RandomAccessByteSource, signal?: AbortSignal): Promise<bigint> {
  signal?.throwIfAborted()
  const hash = await xxh3Chunks(readByteSourceChunks(source, STREAMING_FILE_READ_CHUNK_BYTES, signal))
  signal?.throwIfAborted()
  return hash
}

/** Prepare a lazy optical transfer. Compression reads the source in bounded
 * slices and large compressed output is disk-backed; containers themselves
 * are built only when getPart() asks for one. */
export async function prepareOpticalTransfer(
  file: File | OpticalMemoryFile,
  {
    signal,
    mediaType = file.type,
    partPayloadSize = MAX_FILE_BYTES,
    opfsThreshold = OPFS_LARGE_FILE_THRESHOLD_BYTES,
  }: PrepareOpticalTransferOptions = {},
): Promise<PreparedOpticalTransfer> {
  const memoryBacked = !(file instanceof File)
  const source = memoryBacked ? arrayBufferByteSource(file.data) : fileByteSource(file)
  signal?.throwIfAborted()
  if (source.size === 0) throw new Error("Choose a non-empty file.")
  if (source.size > MAX_TRANSFER_BYTES) throw new RangeError("The optical file is too large to split.")

  const compressedPayloadLimit = compressedPartPayloadLimit(file.name, mediaType, partPayloadSize)
  let compressed: StoredCompressedPayload | undefined
  let compressionProbeHash: bigint | undefined

  if (isOpticalCompressionCandidate(file.name, mediaType, source.size, partPayloadSize)) {
    const candidate = await compressFile(source, `${file.name}.zst`, opfsThreshold, !memoryBacked, signal)
    compressionProbeHash = candidate.sourceHash
    if (candidate.source.size <= source.size - 64) compressed = candidate
    else await candidate.cleanup?.()
  }

  try {
    const payloadSource = compressed?.source ?? source
    const payloadBytesPerPart = compressed ? compressedPayloadLimit : partPayloadSize
    const partCount = Math.ceil(payloadSource.size / payloadBytesPerPart)
    const partCountField = partCount - 1
    if (partCountField > MAX_PART_COUNT) throw new RangeError("The optical file is too large to split.")

    const transferId = partCount > 1 ? (compressionProbeHash ?? (await wholeFileTransferId(source, signal))) : undefined
    const compression: CompressionMode = compressed ? (partCount > 1 ? "zstd-fragment" : "zstd") : "none"
    const largestPayload = Math.min(payloadSource.size, payloadBytesPerPart)
    let disposed = false

    return {
      summary: {
        containerSize: opticalContainerSize(file.name, mediaType, largestPayload),
        compression: compressed ? "zstd" : "none",
        originalSize: source.size,
        transmittedSize: payloadSource.size,
        partCount,
      },
      async getPart(index, partSignal) {
        if (disposed) throw new Error("The optical file is no longer prepared.")
        if (!Number.isInteger(index) || index < 0 || index >= partCount) {
          throw new RangeError("The optical file part index is invalid.")
        }
        signal?.throwIfAborted()
        partSignal?.throwIfAborted()
        const start = index * payloadBytesPerPart
        const end = Math.min(payloadSource.size, start + payloadBytesPerPart)
        const checkedSource: RandomAccessByteSource = {
          size: payloadSource.size,
          async read(readStart, readEnd) {
            signal?.throwIfAborted()
            partSignal?.throwIfAborted()
            const chunk = await payloadSource.read(readStart, readEnd)
            signal?.throwIfAborted()
            partSignal?.throwIfAborted()
            return chunk
          },
        }
        const packed = await packTransferPayloadFromSource(
          file.name,
          mediaType,
          checkedSource,
          start,
          end,
          {
            compression,
            originalSize: compressed ? source.size : end - start,
            index,
            count: partCountField,
            transferId,
          },
          partSignal,
        )
        signal?.throwIfAborted()
        partSignal?.throwIfAborted()
        return packed
      },
      async cleanup() {
        if (disposed) return
        disposed = true
        await compressed?.cleanup?.()
      },
    }
  } catch (error) {
    await compressed?.cleanup?.()
    throw error
  }
}
