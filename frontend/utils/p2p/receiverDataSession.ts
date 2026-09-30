import type { DataMessage, P2PFileMeta, P2PReceiverCallbacks, P2PVerificationManifest } from "./protocol.js"
import type { ReceiverTransferLifecycle, ReceiverTransferState } from "./receiverSession.js"
import type { ReceiverStorageCoordinator } from "./receiverStorageCoordinator.js"
import type { ReceiverVerificationState } from "./receiverVerification.js"
import type { P2PResumeCheckpoint } from "../p2pReceiveStore.js"
import { ensureXXHashReady } from "../../wasm/xxhash-loader.js"
import { createSpeedTracker, measureSpeed, progressUpdateIntervalMs, receiveAckIntervalBytes } from "./transfer.js"
import { maxVerificationRepairAttempts, verificationBlockByteLength } from "./verification.js"
import { verificationBlockSize } from "./protocol.js"

const maxIncompleteTransferRetries = 3

interface ReceiverDataSessionOptions {
  meta(): P2PFileMeta | undefined
  forceMemoryStorage(): boolean
  transfer: ReceiverTransferLifecycle
  storage: ReceiverStorageCoordinator
  verification: ReceiverVerificationState
  callbacks: Pick<P2PReceiverCallbacks, "onProgress" | "onStatus" | "onError">
  send(message: DataMessage): void
  transition(next: ReceiverTransferState): void
  onComplete(file: File, status: string): void
  onFailure(message: string, isCurrent: () => boolean): Promise<void>
}

/** Owns committed bytes, checkpoints, verification and repair for one receive stream.
 * Connection changes and completion notifications belong to the receiver controller. */
export class ReceiverDataSession {
  private committedBytes = 0
  private speedTracker = createSpeedTracker(0)
  private lastProgressAt = 0
  private flowBytes = 0
  private lastAcknowledgedBytes = 0

  constructor(private readonly options: ReceiverDataSessionOptions) {}

  get receivedBytes(): number {
    return this.committedBytes
  }

  clear(): void {
    this.committedBytes = 0
    this.reset()
    this.options.verification.clear()
  }

  discard(): Promise<void> {
    return this.options.storage.reset(() => this.clear())
  }

  async prepare(): Promise<void> {
    const meta = this.options.meta()
    if (!meta) return
    await this.options.storage.prepare(
      meta,
      this.options.forceMemoryStorage(),
      () => this.committedBytes === 0,
      () => this.clear(),
    )
  }

  async restore(checkpoint: P2PResumeCheckpoint): Promise<void> {
    const completedHashBytes = checkpoint.meta.verifyTransfer
      ? checkpoint.completedHashes.length * verificationBlockSize
      : checkpoint.receivedBytes
    const tail = await this.options.storage.restore(checkpoint.receivedBytes, completedHashBytes)
    this.committedBytes = checkpoint.receivedBytes
    if (checkpoint.meta.verifyTransfer) {
      await ensureXXHashReady()
      this.options.verification.startHash(checkpoint.completedHashes.slice())
      await this.options.verification.appendFileChunk(tail)
    }
    this.reset()
  }

  checkpoint(force = false): Promise<void> {
    return this.options.storage.enqueue(() => this.checkpointData(force))
  }

  reset(): void {
    this.speedTracker = createSpeedTracker(this.committedBytes)
    this.lastProgressAt = performance.now()
    this.flowBytes = 0
    this.lastAcknowledgedBytes = 0
  }

  speed(receivedBytes: number, force = false): number {
    return measureSpeed(this.speedTracker, receivedBytes, force)
  }

  reportRepairProgress(): void {
    const meta = this.options.meta()
    if (!meta) return
    const doneBytes = Math.max(0, meta.size - this.options.verification.repairBytes(meta.size))
    this.options.callbacks.onProgress({ doneBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
    this.options.send({ type: "progress", doneBytes, revision: meta.revision })
  }

  startRepair(index: number, size: number): void {
    const meta = this.options.meta()
    const { verification } = this.options
    if (!verification.manifest || index >= verification.manifest.hashes.length) {
      throw new Error("Invalid P2P repair block index.")
    }
    if (size !== verificationBlockByteLength(index, meta?.size ?? 0)) {
      throw new Error("P2P repair block size mismatch.")
    }
    verification.startRepairBlock(index, size)
    this.options.callbacks.onStatus(`Repairing block ${index + 1}...`)
  }

  async finishRepair(index: number, isCurrent: () => boolean): Promise<void> {
    const { verification } = this.options
    const repaired = verification.finishRepairBlock(index)
    if (!repaired) return
    await this.options.storage.replaceBlock(index, repaired.parts)
    if (!isCurrent()) return
    const indices = verification.completeRepair(index, repaired.repairedHash)
    this.reportRepairProgress()
    if (indices && verification.manifest) {
      this.options.callbacks.onStatus("Verifying repaired blocks...")
      this.options.transition({ kind: "verifying" })
      await this.verifyOrRequestRepair(verification.manifest, indices, isCurrent)
    }
  }

  /** Returns true only when the controller must request the missing suffix. */
  async finishTransfer(
    inlineManifest: P2PVerificationManifest | undefined,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const meta = this.options.meta()
    const { verification, callbacks } = this.options
    if (!meta || this.options.transfer.isDiscarding()) return false
    if (this.committedBytes < meta.size) {
      verification.clearManifestAssembly()
      const retry = verification.nextIncompleteRetry(maxIncompleteTransferRetries)
      if (retry === undefined) {
        await this.fail(`P2P transfer remained incomplete after ${maxIncompleteTransferRetries} retries.`, isCurrent)
        return false
      }
      callbacks.onStatus(
        `Transfer ended early at ${this.committedBytes} of ${meta.size} bytes. Requesting the missing data ` +
          `(retry ${retry}/${maxIncompleteTransferRetries})...`,
      )
      callbacks.onProgress({ doneBytes: this.committedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
      return true
    }
    if (meta.verifyTransfer) {
      const result = verification.finishManifest(inlineManifest, meta.size)
      if ("error" in result) {
        callbacks.onError(new Error(result.error))
        return false
      }
      this.options.transition({ kind: "verifying" })
      callbacks.onStatus("Verifying transfer...")
      await this.verifyOrRequestRepair(result.manifest, undefined, isCurrent)
    } else {
      await this.complete("Transfer complete.", isCurrent)
    }
    return false
  }

  private async complete(status: string, isCurrent: () => boolean): Promise<void> {
    const meta = this.options.meta()
    if (!meta) return
    const file = await this.options.storage.file(meta)
    if (!isCurrent()) return
    if (file.size !== meta.size) {
      await this.fail(`Stored P2P file size mismatch: expected ${meta.size} bytes, got ${file.size} bytes.`, isCurrent)
      return
    }
    this.options.verification.resetIncompleteRetries()
    this.options.onComplete(file, status)
  }

  private async fail(message: string, isCurrent: () => boolean): Promise<void> {
    await this.options.onFailure(message, isCurrent)
    if (isCurrent()) this.options.callbacks.onError(new Error(message))
  }

  private async verifyOrRequestRepair(
    manifest: P2PVerificationManifest,
    indices: Iterable<number> | undefined,
    isCurrent: () => boolean,
  ): Promise<void> {
    const { verification, storage, callbacks } = this.options
    const mismatches = await verification.mismatches(
      manifest,
      (index) => storage.verificationParts(index),
      indices,
      isCurrent,
    )
    if (!isCurrent()) return
    if (mismatches.length === 0) {
      this.options.send({ type: "verified" })
      await this.complete("File received and verified. Saving should start automatically.", isCurrent)
      return
    }
    if (!verification.beginRepair(mismatches, maxVerificationRepairAttempts)) {
      await this.fail(`Transfer verification failed after ${maxVerificationRepairAttempts} repair attempts.`, isCurrent)
      return
    }
    this.options.transition({ kind: "repairing" })
    this.reportRepairProgress()
    callbacks.onStatus(`Repairing ${mismatches.length} block${mismatches.length === 1 ? "" : "s"}...`)
    this.options.send({ type: "repair-request", indices: mismatches })
  }

  private async checkpointData(force = false): Promise<void> {
    const meta = this.options.meta()
    if (!meta) return
    await this.options.storage.checkpointData(
      { meta, receivedBytes: this.committedBytes, completedHashes: () => this.options.verification.completedHashes() },
      force,
    )
  }

  private async appendFileData(chunk: ArrayBuffer): Promise<void> {
    await this.options.storage.enqueue(async () => {
      const meta = this.options.meta()
      if (!meta) return
      await this.options.storage.initialize(meta, this.options.forceMemoryStorage())
      // Persistent storage detaches the input buffer after the hash has consumed it.
      const length = chunk.byteLength
      await this.options.verification.appendFileChunk(chunk)
      await this.options.storage.append(this.committedBytes, chunk)
      this.committedBytes += length
      await this.checkpointData()
    })
  }

  async receive(data: unknown, isCurrent: () => boolean): Promise<void> {
    const { transfer, verification } = this.options
    if (!this.options.meta() || transfer.isDiscarding()) return
    const expectsFile = transfer.wantsDownload() || transfer.isPausePending()
    const expectsRepair = transfer.isRepairing() && verification.hasRepairBlock
    if (!expectsFile && !expectsRepair) {
      throw new Error("Unexpected P2P binary data for the current transfer state.")
    }
    const chunk = data instanceof Blob ? await data.arrayBuffer() : data
    if (!(chunk instanceof ArrayBuffer)) throw new Error("Invalid P2P binary data.")
    if (!isCurrent()) return
    const meta = this.options.meta()
    const receivedBytes = this.committedBytes
    if (!meta) return
    // Storage can detach the buffer, so capture its length before handing it off.
    const length = chunk.byteLength
    if (verification.hasRepairBlock) {
      await verification.appendRepairChunk(chunk)
      if (!isCurrent()) return
      this.flowBytes += length
      this.acknowledge()
      return
    }
    if (receivedBytes > meta.size || length > meta.size - receivedBytes) {
      throw new Error("P2P transfer exceeds the declared file size.")
    }
    await this.appendFileData(chunk)
    if (!isCurrent()) return
    this.flowBytes += length
    const currentMeta = this.options.meta()
    const now = performance.now()
    const report =
      now - this.lastProgressAt >= progressUpdateIntervalMs || this.committedBytes >= (currentMeta?.size ?? meta.size)
    this.acknowledge(report)
    if (currentMeta && report) {
      this.lastProgressAt = now
      this.options.callbacks.onProgress({
        doneBytes: this.committedBytes,
        totalBytes: currentMeta.size,
        speedBytesPerSecond: this.speed(this.committedBytes),
      })
    }
  }

  private acknowledge(force = false): void {
    const meta = this.options.meta()
    const receivedBytes = this.committedBytes
    if (!meta || (!force && this.flowBytes - this.lastAcknowledgedBytes < receiveAckIntervalBytes)) return
    this.lastAcknowledgedBytes = this.flowBytes
    this.options.send({
      type: "progress",
      doneBytes: receivedBytes,
      revision: meta.revision,
      flowBytes: this.flowBytes,
    })
  }
}
