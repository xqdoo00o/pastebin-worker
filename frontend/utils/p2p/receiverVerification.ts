import {
  appendHashData,
  createBlockHashState,
  disposeHashData,
  finishHashData,
  verificationBlocksByteLength,
  verificationHashIndices,
  xxh3Hex,
  type BlockHashState,
} from "./verification.js"
import { verificationBlockSize, type P2PVerificationManifest } from "./protocol.js"

interface VerificationManifestAssembly {
  blockSize: number
  hashCount: number
  hashes: string[]
}

export type VerificationManifestResult =
  { manifest: P2PVerificationManifest; error?: never } | { manifest?: never; error: string }

/** Reassembles chunked verification manifests without leaking protocol state into the receiver loop. */
export class ReceiverVerificationManifestCollector {
  #assembly: VerificationManifestAssembly | undefined

  start(fileSize: number, blockSize: number, hashCount: number): void {
    const expectedHashCount = Math.ceil(fileSize / verificationBlockSize)
    if (hashCount !== expectedHashCount) {
      throw new Error("Transfer verification manifest length mismatch.")
    }
    this.#assembly = { blockSize, hashCount, hashes: [] }
  }

  append(startIndex: number, hashes: string[]): void {
    const assembly = this.#assembly
    if (startIndex !== assembly?.hashes.length) {
      throw new Error("Transfer verification manifest chunks are out of order.")
    }
    if (assembly.hashes.length + hashes.length > assembly.hashCount) {
      throw new Error("Transfer verification manifest contains too many hashes.")
    }
    assembly.hashes.push(...hashes)
  }

  finish(inlineManifest: P2PVerificationManifest | undefined, fileSize: number): VerificationManifestResult {
    const assembly = this.#assembly
    this.#assembly = undefined
    const manifest =
      inlineManifest ?? (assembly ? { blockSize: assembly.blockSize, hashes: assembly.hashes } : undefined)
    if (!manifest) return { error: "Transfer verification manifest missing." }
    if (manifest.blockSize !== verificationBlockSize) {
      return { error: "Transfer verification block size mismatch." }
    }
    if (manifest.hashes.length !== Math.ceil(fileSize / verificationBlockSize)) {
      return { error: "Transfer verification manifest length mismatch." }
    }
    return { manifest }
  }

  clear(): void {
    this.#assembly = undefined
  }
}

interface RepairBlockState {
  index: number
  size: number
  bytes: number
  parts: ArrayBuffer[]
  hashState?: BlockHashState
}

/** Owns incremental hashes, manifest assembly, retry counters and repair blocks. */
export class ReceiverVerificationState {
  readonly #manifestCollector = new ReceiverVerificationManifestCollector()
  #manifest: P2PVerificationManifest | undefined
  #pendingRepairIndices = new Set<number>()
  #repairVerificationIndices = new Set<number>()
  #repairBlock: RepairBlockState | undefined
  #repairAttempts = 0
  #incompleteRetries = 0
  #hashState: BlockHashState | undefined

  get manifest(): P2PVerificationManifest | undefined {
    return this.#manifest
  }

  get hasRepairBlock(): boolean {
    return this.#repairBlock !== undefined
  }

  clear(): void {
    disposeHashData(this.#hashState)
    this.#hashState = undefined
    this.#manifest = undefined
    this.#manifestCollector.clear()
    this.#pendingRepairIndices.clear()
    this.#repairVerificationIndices.clear()
    this.clearRepairBlock()
    this.#repairAttempts = 0
    this.#incompleteRetries = 0
  }

  startHash(completedHashes: string[] = []): void {
    disposeHashData(this.#hashState)
    this.#hashState = createBlockHashState(completedHashes)
  }

  async appendFileChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.#hashState) await appendHashData(this.#hashState, chunk)
  }

  completedHashes(): string[] {
    return this.#hashState?.hashes.slice() ?? []
  }

  startManifest(fileSize: number, blockSize: number, hashCount: number): void {
    this.#manifestCollector.start(fileSize, blockSize, hashCount)
  }

  appendManifest(startIndex: number, hashes: string[]): void {
    this.#manifestCollector.append(startIndex, hashes)
  }

  finishManifest(inlineManifest: P2PVerificationManifest | undefined, fileSize: number): VerificationManifestResult {
    const result = this.#manifestCollector.finish(inlineManifest, fileSize)
    if (result.manifest) this.#manifest = result.manifest
    return result
  }

  clearManifestAssembly(): void {
    this.#manifestCollector.clear()
  }

  nextIncompleteRetry(maxRetries: number): number | undefined {
    if (this.#incompleteRetries >= maxRetries) return undefined
    this.#incompleteRetries += 1
    return this.#incompleteRetries
  }

  resetIncompleteRetries(): void {
    this.#incompleteRetries = 0
  }

  async mismatches(
    manifest: P2PVerificationManifest,
    verificationParts: (index: number) => readonly ArrayBuffer[] | undefined,
    indicesToVerify?: Iterable<number>,
    isCurrent: () => boolean = () => true,
  ): Promise<number[]> {
    if (this.#hashState) finishHashData(this.#hashState)
    if (!isCurrent()) return []
    const mismatches: number[] = []
    for (const index of verificationHashIndices(manifest, indicesToVerify)) {
      if (!isCurrent()) return []
      const actual = this.#hashState?.hashes[index] ?? (await xxh3Hex(verificationParts(index) ?? []))
      if (actual !== manifest.hashes[index]) mismatches.push(index)
    }
    return mismatches.sort((a, b) => a - b)
  }

  beginRepair(mismatches: number[], maxAttempts: number): boolean {
    this.#repairAttempts += 1
    if (this.#repairAttempts > maxAttempts) return false
    this.#pendingRepairIndices = new Set(mismatches)
    this.#repairVerificationIndices = new Set(mismatches)
    return true
  }

  repairBytes(fileSize: number): number {
    return verificationBlocksByteLength(this.#pendingRepairIndices, fileSize)
  }

  startRepairBlock(index: number, size: number): void {
    this.clearRepairBlock()
    this.#repairBlock = {
      index,
      size,
      bytes: 0,
      parts: [],
      hashState: this.#hashState ? createBlockHashState() : undefined,
    }
  }

  async appendRepairChunk(chunk: ArrayBuffer): Promise<void> {
    const block = this.#repairBlock
    if (!block) throw new Error("P2P repair block is unavailable.")
    if (block.bytes + chunk.byteLength > block.size) throw new Error("P2P repair block exceeds its declared size.")
    if (block.hashState) await appendHashData(block.hashState, chunk)
    block.parts.push(chunk)
    block.bytes += chunk.byteLength
  }

  finishRepairBlock(index: number): { parts: ArrayBuffer[]; repairedHash?: string } | undefined {
    const block = this.#repairBlock
    if (block?.index !== index) return undefined
    if (block.bytes !== block.size) {
      this.clearRepairBlock()
      throw new Error(`Repaired block ${index} size mismatch.`)
    }
    const repairedHash = block.hashState ? finishHashData(block.hashState)[0] : undefined
    const parts = block.parts
    this.#repairBlock = undefined
    return { parts, repairedHash }
  }

  completeRepair(index: number, repairedHash?: string): number[] | undefined {
    if (repairedHash && this.#hashState?.hashes) this.#hashState.hashes[index] = repairedHash
    this.#pendingRepairIndices.delete(index)
    if (this.#pendingRepairIndices.size > 0) return undefined
    const indices = [...this.#repairVerificationIndices]
    this.#repairVerificationIndices.clear()
    return indices
  }

  clearRepairBlock(): void {
    disposeHashData(this.#repairBlock?.hashState)
    this.#repairBlock = undefined
  }
}
