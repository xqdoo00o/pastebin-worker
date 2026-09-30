import { createStreamingZstdDecompressor, type StreamingDecompressor } from "../../wasm/zstd-runtime.js"
import { createStreamingXXH3, type StreamingXXH3 } from "../../wasm/xxhash-runtime.js"
import { createOPFSTemporaryFile, type CompletedOPFSTemporaryFile, type OPFSTemporaryFile } from "../../utils/opfs.js"
import type { CompressionMode, OpticalFile } from "../shared/protocol.js"
import type { ExpectedOpticalTransfer } from "../shared/fountain.js"
import { asArrayBufferView } from "../../../shared/bytes.js"
import { STREAMING_FILE_READ_CHUNK_BYTES } from "../../../shared/constants.js"
import { blobByteSource, readByteSourceChunks, type RandomAccessByteSource } from "../../utils/byteSource.js"

export interface StoredOpticalTransfer extends CompletedOPFSTemporaryFile {
  transmittedSize: number
  wasCompressed: boolean
}

export interface MultipartOpticalProgress {
  received: number
  total: number
  missing: number[]
}

type TemporaryFileFactory = (expectedSize: number, purpose: "optical") => Promise<OPFSTemporaryFile>
type StreamingDecoderFactory = (maxBytes: number) => Promise<StreamingDecompressor>

interface TransferIdentity {
  transferId: bigint
  count: number
  name: string
  type: string
  compression: CompressionMode
  decompressedSize: number | undefined
}

interface Assembly {
  identity: TransferIdentity
  controller: AbortController
  received: Set<number>
  /** Only disk-backed Files and cleanup handles survive accept(). */
  pending: Map<number, CompletedOPFSTemporaryFile>
  temporary?: OPFSTemporaryFile
  decoder?: StreamingDecompressor
  hasher?: StreamingXXH3
  nextIndex: number
  written: number
  expectedRawSize: number
  transmittedSize: number
}

/** A valid multipart container that belongs to another file. The current
 * assembly remains intact so the receiver can continue with the expected part. */
export class OpticalPartTransferMismatchError extends Error {
  constructor(message = "This optical part belongs to a different transfer.") {
    super(message)
    this.name = "OpticalPartTransferMismatchError"
  }
}

/** In-order parts go straight to the output. Out-of-order parts are staged
 * in OPFS, then read back in bounded chunks and deleted as gaps are filled. */
export class MultipartOpticalAssembler {
  private assembly: Assembly | undefined
  private generation = 0
  private work: Promise<void> = Promise.resolve()

  constructor(
    private readonly createTemporaryFile: TemporaryFileFactory = createOPFSTemporaryFile,
    private readonly createDecoder: StreamingDecoderFactory = createStreamingZstdDecompressor,
  ) {}

  progress(): MultipartOpticalProgress | undefined {
    const expected = this.expectedTransfer()
    if (!expected) return undefined
    const total = expected.count + 1
    return { received: total - expected.missing.length, total, missing: expected.missing.map((index) => index + 1) }
  }

  expectedTransfer(): ExpectedOpticalTransfer | undefined {
    const state = this.assembly
    if (!state) return undefined
    const missing: number[] = []
    for (let index = 0; index <= state.identity.count; index++) {
      if (!state.received.has(index)) missing.push(index)
    }
    return { transferId: state.identity.transferId, count: state.identity.count, missing }
  }

  /** Reject input that cannot belong to the multipart transfer in progress. */
  assertCompatibleTransfer(file: OpticalFile): void {
    const identity = this.assembly?.identity
    if (!identity) return
    if (file.part.count === 0 || file.part.transferId === undefined) {
      throw new OpticalPartTransferMismatchError(
        "This standalone optical file does not belong to the multipart transfer in progress.",
      )
    }
    if (identity.transferId !== file.part.transferId) throw new OpticalPartTransferMismatchError()
  }

  accept(file: OpticalFile): Promise<StoredOpticalTransfer | undefined> {
    const generation = this.generation
    const pending = this.work.then(() => {
      if (generation !== this.generation) throw new DOMException("Optical assembly was reset.", "AbortError")
      return this.acceptPart(file)
    })
    // A rejected input must not poison the next receive or reset.
    this.work = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  private async acceptPart(file: OpticalFile): Promise<StoredOpticalTransfer | undefined> {
    this.assertCompatibleTransfer(file)
    if (file.part.count === 0 || file.part.transferId === undefined) {
      throw new Error("A standalone optical file cannot enter the multi-part assembler.")
    }
    const state = (this.assembly ??= {
      identity: {
        transferId: file.part.transferId,
        count: file.part.count,
        name: file.name,
        type: file.type,
        compression: file.compression,
        decompressedSize: file.decompressedSize,
      },
      controller: new AbortController(),
      received: new Set<number>(),
      pending: new Map<number, CompletedOPFSTemporaryFile>(),
      nextIndex: 0,
      written: 0,
      expectedRawSize: 0,
      transmittedSize: 0,
    })
    try {
      this.validatePart(state, file)
      if (state.received.has(file.part.index)) return undefined
      state.transmittedSize += file.transmittedSize
      if (file.compression !== "zstd-fragment") state.expectedRawSize += file.bytes.length
      if (!Number.isSafeInteger(state.transmittedSize) || !Number.isSafeInteger(state.expectedRawSize)) {
        throw new RangeError("The optical transfer is too large.")
      }

      if (file.part.index === state.nextIndex) {
        if (!state.temporary) await this.startOutput(state, file.bytes.length)
        await this.append(state, {
          size: file.bytes.length,
          read: (start, end) => asArrayBufferView(file.bytes.subarray(start, end)),
        })
        state.nextIndex++
        await this.flushContiguousParts(state)
      } else {
        await this.stagePart(state, file)
      }
      state.controller.signal.throwIfAborted()
      // Only persisted parts count as received.
      state.received.add(file.part.index)
      if (state.received.size !== state.identity.count + 1) return undefined
      if (state.nextIndex !== state.identity.count + 1 || state.pending.size !== 0) {
        throw new Error("The optical transfer is missing parts.")
      }
      return await this.complete(state)
    } catch (error) {
      if (this.assembly === state) this.assembly = undefined
      await this.dispose(state)
      throw error
    }
  }

  reset(): Promise<void> {
    const state = this.assembly
    this.assembly = undefined
    this.generation++
    state?.controller.abort()
    // Progress disappears synchronously. Let any in-flight write/finish settle
    // before deleting its resources, and serialize the next transfer behind it.
    const cleanup = this.work.then(() => (state ? this.dispose(state) : undefined))
    this.work = cleanup
    return cleanup
  }

  private validatePart(state: Assembly, file: OpticalFile): void {
    const identity = state.identity
    if (file.part.index < 0 || file.part.index > identity.count) {
      throw new Error("The optical part index is invalid.")
    }
    if (
      file.part.count !== identity.count ||
      file.part.transferId !== identity.transferId ||
      file.name !== identity.name ||
      file.type !== identity.type ||
      file.compression !== identity.compression
    ) {
      throw new Error("The optical parts disagree about their transfer metadata.")
    }
    if (identity.compression === "zstd-fragment" && file.decompressedSize !== identity.decompressedSize) {
      throw new Error("The optical parts disagree about their decompressed size.")
    }
  }

  private async stagePart(state: Assembly, part: OpticalFile): Promise<void> {
    const temporary = await this.createTemporaryFile(part.bytes.length, "optical")
    try {
      state.controller.signal.throwIfAborted()
      await temporary.write(asArrayBufferView(part.bytes))
      state.controller.signal.throwIfAborted()
      const stored = await temporary.finish(`part-${part.part.index}.bin`, "application/octet-stream")
      state.pending.set(part.part.index, stored)
      state.controller.signal.throwIfAborted()
      if (stored.file.size !== part.bytes.length) throw new Error("The stored optical part has an invalid size.")
    } catch (error) {
      await temporary.abort()
      throw error
    }
  }

  private async startOutput(state: Assembly, firstPartSize: number): Promise<void> {
    const identity = state.identity
    const expectedSize =
      identity.compression === "zstd-fragment" ? (identity.decompressedSize ?? 0) : firstPartSize * (identity.count + 1)
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error("The optical transfer has an invalid output size.")
    }
    state.temporary = await this.createTemporaryFile(expectedSize, "optical")
    state.controller.signal.throwIfAborted()
    state.hasher = await createStreamingXXH3()
    state.controller.signal.throwIfAborted()
    if (identity.compression === "zstd-fragment") state.decoder = await this.createDecoder(expectedSize)
    state.controller.signal.throwIfAborted()
  }

  private async flushContiguousParts(state: Assembly): Promise<void> {
    while (state.temporary) {
      const stored = state.pending.get(state.nextIndex)
      if (!stored) return
      await this.append(state, blobByteSource(stored.file))
      await stored.cleanup()
      state.pending.delete(state.nextIndex)
      state.controller.signal.throwIfAborted()
      state.nextIndex++
    }
  }

  private async append(state: Assembly, source: RandomAccessByteSource): Promise<void> {
    for await (const chunk of readByteSourceChunks(source, STREAMING_FILE_READ_CHUNK_BYTES, state.controller.signal)) {
      const outputs = state.decoder ? state.decoder.pushChunks(chunk) : [chunk]
      for (const bytes of outputs) {
        if (bytes.length === 0) continue
        const declaredSize = state.identity.decompressedSize
        if (declaredSize !== undefined && state.written + bytes.length > declaredSize) {
          throw new Error("The decompressed file exceeds its declared size.")
        }
        await state.temporary!.write(asArrayBufferView(bytes))
        state.controller.signal.throwIfAborted()
        state.hasher!.update(bytes)
        state.written += bytes.length
      }
    }
  }

  private async complete(state: Assembly): Promise<StoredOpticalTransfer> {
    const identity = state.identity
    state.decoder?.finish()
    const expectedSize = identity.compression === "zstd-fragment" ? identity.decompressedSize! : state.expectedRawSize
    if (state.written !== expectedSize) throw new Error("The reassembled file does not match its declared size.")
    const completed = await state.temporary!.finish(identity.name, identity.type)
    state.temporary = undefined
    try {
      state.controller.signal.throwIfAborted()
      if (completed.file.size !== expectedSize)
        throw new Error("The stored optical file does not match its declared size.")
      if (state.hasher!.digest() !== identity.transferId) {
        throw new Error("The reassembled file does not match its transfer id.")
      }
    } catch (error) {
      await completed.cleanup()
      throw error
    }
    const result = {
      ...completed,
      transmittedSize: state.transmittedSize,
      wasCompressed: identity.compression === "zstd-fragment",
    }
    if (this.assembly === state) this.assembly = undefined
    await this.dispose(state)
    return result
  }

  private async dispose(state: Assembly): Promise<void> {
    const temporary = state.temporary
    const pending = [...state.pending.values()]
    state.temporary = undefined
    state.pending.clear()
    state.decoder?.free()
    state.decoder = undefined
    state.hasher?.free()
    state.hasher = undefined
    // Attempt every cleanup even when one file fails. OPFS also queues failed
    // deletions for its existing later cleanup pass.
    await Promise.allSettled([...(temporary ? [temporary.abort()] : []), ...pending.map((part) => part.cleanup())])
  }
}
