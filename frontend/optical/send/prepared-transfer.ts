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

export interface OpticalTransferParts {
  readonly summary: PreparedOpticalFile
  getPart(index: number, signal?: AbortSignal): Promise<PackedOpticalFile>
}

export interface PreparedOpticalPayload {
  partition(partPayloadSize: number): Promise<OpticalTransferParts>
  cleanup(): Promise<void>
}

export interface PrepareOpticalPayloadOptions {
  signal?: AbortSignal
  /** Media type serialized into DCF5; permits presentation metadata without
   * wrapping a potentially large disk-backed File. */
  mediaType?: string
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
    const chunks: Uint8Array[] = []
    let length = 0
    await produce((chunk) => {
      if (chunk.byteLength === 0) return Promise.resolve()
      // The zstd runtime returns owned copies, valid after its next call/free.
      chunks.push(chunk)
      length += chunk.byteLength
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

/** Own the source, optional compressed output and lazy whole-file hash once.
 * Part views are cheap and borrow these resources until cleanup(). */
export async function prepareOpticalPayload(
  file: File | OpticalMemoryFile,
  { signal, mediaType = file.type, opfsThreshold = OPFS_LARGE_FILE_THRESHOLD_BYTES }: PrepareOpticalPayloadOptions = {},
): Promise<PreparedOpticalPayload> {
  const memoryBacked = !(file instanceof File)
  const source = memoryBacked ? arrayBufferByteSource(file.data) : fileByteSource(file)
  signal?.throwIfAborted()
  if (source.size === 0) throw new Error("Choose a non-empty file.")
  if (source.size > MAX_TRANSFER_BYTES) throw new RangeError("The optical file is too large to split.")

  let compressed: StoredCompressedPayload | undefined
  let sourceHash: Promise<bigint> | undefined
  if (isOpticalCompressionCandidate(file.name, mediaType, source.size)) {
    const candidate = await compressFile(source, `${file.name}.zst`, opfsThreshold, !memoryBacked, signal)
    sourceHash = Promise.resolve(candidate.sourceHash)
    if (candidate.source.size <= source.size - 64) compressed = candidate
    else await candidate.cleanup?.()
  }
  const payloadSource = compressed?.source ?? source
  let disposed = false
  const assertActive = () => {
    if (disposed) throw new Error("The optical file is no longer prepared.")
    signal?.throwIfAborted()
  }

  return {
    async partition(partPayloadSize) {
      assertActive()
      if (!Number.isSafeInteger(partPayloadSize) || partPayloadSize <= 0 || partPayloadSize > MAX_FILE_BYTES) {
        throw new RangeError("Invalid optical part payload size.")
      }
      const payloadBytesPerPart = compressed
        ? compressedPartPayloadLimit(file.name, mediaType, partPayloadSize)
        : partPayloadSize
      if (payloadBytesPerPart <= 0) throw new RangeError("The optical part budget cannot fit its metadata.")
      const partCount = Math.ceil(payloadSource.size / payloadBytesPerPart)
      const partCountField = partCount - 1
      if (partCountField > MAX_PART_COUNT) {
        throw new RangeError(
          `The optical file needs ${partCount} parts at this frame size; at most ${MAX_PART_COUNT + 1} are supported. ` +
            "Increase Bytes / Frame or choose a smaller file.",
        )
      }
      const transferId = partCount > 1 ? await (sourceHash ??= wholeFileTransferId(source, signal)) : undefined
      assertActive()
      const compression: CompressionMode = compressed ? (partCount > 1 ? "zstd-fragment" : "zstd") : "none"
      const largestPayload = Math.min(payloadSource.size, payloadBytesPerPart)
      return {
        summary: {
          containerSize: opticalContainerSize(file.name, mediaType, largestPayload),
          compression: compressed ? "zstd" : "none",
          originalSize: source.size,
          transmittedSize: payloadSource.size,
          partCount,
        },
        async getPart(index, partSignal) {
          assertActive()
          if (!Number.isInteger(index) || index < 0 || index >= partCount) {
            throw new RangeError("The optical file part index is invalid.")
          }
          partSignal?.throwIfAborted()
          const start = index * payloadBytesPerPart
          const end = Math.min(payloadSource.size, start + payloadBytesPerPart)
          const checkedSource: RandomAccessByteSource = {
            size: payloadSource.size,
            async read(readStart, readEnd) {
              assertActive()
              partSignal?.throwIfAborted()
              const chunk = await payloadSource.read(readStart, readEnd)
              assertActive()
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
          assertActive()
          partSignal?.throwIfAborted()
          return packed
        },
      }
    },
    async cleanup() {
      if (disposed) return
      disposed = true
      await compressed?.cleanup?.()
    },
  }
}
