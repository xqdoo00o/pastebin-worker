import { createStreamingZstdDecompressor, type StreamingDecompressor } from "../../wasm/zstd-runtime.js"
import { createStreamingXXH3, type StreamingXXH3 } from "../../wasm/xxhash-runtime.js"
import { createOPFSTemporaryFile, type CompletedOPFSTemporaryFile, type OPFSTemporaryFile } from "../../utils/opfs.js"
import type { CompressionMode, OpticalFile } from "../shared/protocol.js"
import type { ExpectedOpticalTransfer } from "../shared/fountain.js"
import { asArrayBufferView } from "../../../shared/bytes.js"

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

/** A valid multipart container that belongs to another file. The current
 * assembly remains intact so the receiver can continue with the expected part. */
export class OpticalPartTransferMismatchError extends Error {
  constructor(message = "This optical part belongs to a different transfer.") {
    super(message)
    this.name = "OpticalPartTransferMismatchError"
  }
}

/** Incremental owner of one multi-part receive. As soon as a contiguous part
 * is available it is decoded and appended to OPFS, then its source buffer is
 * released. Out-of-order parts wait only until their predecessor. */
export class MultipartOpticalAssembler {
  private identity: TransferIdentity | undefined
  private readonly received = new Set<number>()
  private readonly pending = new Map<number, OpticalFile>()
  private temporary: OPFSTemporaryFile | undefined
  private decoder: StreamingDecompressor | undefined
  private hasher: StreamingXXH3 | undefined
  private nextIndex = 0
  private written = 0
  private expectedRawSize = 0
  private transmittedSize = 0

  constructor(
    private readonly createTemporaryFile: TemporaryFileFactory = createOPFSTemporaryFile,
    private readonly createDecoder: StreamingDecoderFactory = createStreamingZstdDecompressor,
  ) {}

  progress(): MultipartOpticalProgress | undefined {
    const identity = this.identity
    if (!identity) return undefined
    const missing: number[] = []
    for (let index = 0; index <= identity.count; index++) {
      if (!this.received.has(index)) missing.push(index + 1)
    }
    return { received: this.received.size, total: identity.count + 1, missing }
  }

  expectedTransfer(): ExpectedOpticalTransfer | undefined {
    const identity = this.identity
    if (!identity) return undefined
    const missing: number[] = []
    for (let index = 0; index <= identity.count; index++) {
      if (!this.received.has(index)) missing.push(index)
    }
    return { transferId: identity.transferId, count: identity.count, missing }
  }

  /** Reject input that cannot belong to the multipart transfer in progress. */
  assertCompatibleTransfer(file: OpticalFile): void {
    if (!this.identity) return
    if (file.part.count === 0 || file.part.transferId === undefined) {
      throw new OpticalPartTransferMismatchError(
        "This standalone optical file does not belong to the multipart transfer in progress.",
      )
    }
    if (this.identity.transferId !== file.part.transferId) {
      throw new OpticalPartTransferMismatchError()
    }
  }

  async accept(file: OpticalFile): Promise<StoredOpticalTransfer | undefined> {
    this.assertCompatibleTransfer(file)
    if (file.part.count === 0 || file.part.transferId === undefined) {
      throw new Error("A standalone optical file cannot enter the multi-part assembler.")
    }
    this.identity ??= {
      transferId: file.part.transferId,
      count: file.part.count,
      name: file.name,
      type: file.type,
      compression: file.compression,
      decompressedSize: file.decompressedSize,
    }
    try {
      this.validatePart(file)
    } catch (error) {
      await this.fail()
      throw error
    }
    if (this.received.has(file.part.index)) return undefined

    this.received.add(file.part.index)
    this.pending.set(file.part.index, file)
    this.transmittedSize += file.transmittedSize
    if (file.compression !== "zstd-fragment") this.expectedRawSize += file.bytes.length
    if (!Number.isSafeInteger(this.transmittedSize) || !Number.isSafeInteger(this.expectedRawSize)) {
      await this.fail()
      throw new RangeError("The optical transfer is too large.")
    }

    try {
      if (!this.temporary && this.pending.has(0)) await this.startOutput()
      await this.flushContiguousParts()
      if (this.received.size !== this.identity.count + 1) return undefined
      if (this.nextIndex !== this.identity.count + 1 || this.pending.size !== 0) {
        throw new Error("The optical transfer is missing parts.")
      }
      return await this.complete()
    } catch (error) {
      await this.fail()
      throw error
    }
  }

  async reset(): Promise<void> {
    // Reset is also used from a synchronous UI action. Detach and clear the
    // current transfer before waiting for OPFS cleanup so an immediate render
    // (or a new receive attempt) cannot observe the abandoned part progress.
    const temporary = this.temporary
    this.temporary = undefined
    this.clear()
    if (temporary) await temporary.abort()
  }

  private validatePart(file: OpticalFile): void {
    const identity = this.identity!
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

  private async startOutput(): Promise<void> {
    const identity = this.identity!
    const first = this.pending.get(0)!
    const expectedSize =
      identity.compression === "zstd-fragment"
        ? (identity.decompressedSize ?? 0)
        : first.bytes.length * (identity.count + 1)
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error("The optical transfer has an invalid output size.")
    }
    this.temporary = await this.createTemporaryFile(expectedSize, "optical")
    this.hasher = await createStreamingXXH3()
    if (identity.compression === "zstd-fragment") this.decoder = await this.createDecoder(expectedSize)
  }

  private async flushContiguousParts(): Promise<void> {
    while (this.temporary) {
      const part = this.pending.get(this.nextIndex)
      if (!part) return
      await this.write(this.decoder ? this.decoder.push(part.bytes) : part.bytes)
      this.pending.delete(this.nextIndex)
      this.nextIndex += 1
    }
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return
    const declaredSize = this.identity?.decompressedSize
    if (declaredSize !== undefined && this.written + bytes.length > declaredSize) {
      throw new Error("The decompressed file exceeds its declared size.")
    }
    await this.temporary!.write(asArrayBufferView(bytes))
    this.hasher!.update(bytes)
    this.written += bytes.length
  }

  private async complete(): Promise<StoredOpticalTransfer> {
    const identity = this.identity!
    this.decoder?.finish()
    const expectedSize = identity.compression === "zstd-fragment" ? identity.decompressedSize! : this.expectedRawSize
    if (this.written !== expectedSize) throw new Error("The reassembled file does not match its declared size.")
    const temporary = this.temporary!
    const completed = await temporary.finish(identity.name, identity.type)
    this.temporary = undefined
    if (completed.file.size !== expectedSize) {
      await completed.cleanup()
      throw new Error("The stored optical file does not match its declared size.")
    }
    try {
      if (this.hasher!.digest() !== identity.transferId) {
        throw new Error("The reassembled file does not match its transfer id.")
      }
    } catch (error) {
      await completed.cleanup()
      throw error
    }
    const result = {
      ...completed,
      transmittedSize: this.transmittedSize,
      wasCompressed: identity.compression === "zstd-fragment",
    }
    this.clear()
    return result
  }

  private async fail(): Promise<void> {
    const temporary = this.temporary
    this.temporary = undefined
    try {
      if (temporary) await temporary.abort()
    } finally {
      this.clear()
    }
  }

  private clear(): void {
    this.decoder?.free()
    this.decoder = undefined
    this.hasher?.free()
    this.hasher = undefined
    this.identity = undefined
    this.received.clear()
    this.pending.clear()
    this.nextIndex = 0
    this.written = 0
    this.expectedRawSize = 0
    this.transmittedSize = 0
  }
}
