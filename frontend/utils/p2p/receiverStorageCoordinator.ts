import type { P2PFileMeta } from "./protocol.js"
import {
  p2pCheckpointIntervalBytes,
  removeP2PResumeCheckpoint,
  writeP2PResumeCheckpoint,
  type P2PResumeCheckpoint,
} from "../p2pReceiveStore.js"
import type { ReceiverStorageSession } from "./receiverSession.js"
import type { ReceivedStore } from "./receivedStorage.js"
import type { SignalMessage } from "./protocol.js"

interface ReceiverStorageCoordinatorOptions {
  roomName: string
  peerId: string
  storage: ReceiverStorageSession
  checkpoint?: P2PResumeCheckpoint
  sendSignal: (message: SignalMessage) => boolean
}

interface ReceiverCheckpointSnapshot {
  meta: P2PFileMeta
  receivedBytes: number
  completedHashes: string[]
}

/** Serializes temporary-file operations and owns resume-checkpoint signaling. */
export class ReceiverStorageCoordinator {
  #checkpoint: P2PResumeCheckpoint | undefined
  #lastCheckpointBytes: number
  #registration: "unregistered" | "pending" | "registered" = "unregistered"
  #pendingClear = false
  #queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: ReceiverStorageCoordinatorOptions) {
    this.#checkpoint = options.checkpoint
    this.#lastCheckpointBytes = options.checkpoint?.receivedBytes ?? 0
  }

  get checkpoint(): P2PResumeCheckpoint | undefined {
    return this.#checkpoint
  }

  get kind(): ReceivedStore["kind"] | undefined {
    return this.options.storage.kind
  }

  get hasCurrent(): boolean {
    return this.options.storage.hasCurrent
  }

  get id(): string {
    return this.options.storage.id
  }

  canRestore(): boolean {
    return this.options.storage.canRestore()
  }

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async prepare(
    meta: P2PFileMeta,
    forceMemory: boolean,
    shouldResetEmpty: () => boolean,
    clearData: () => void,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (shouldResetEmpty()) clearData()
      await this.initialize(meta, forceMemory)
    })
  }

  async initialize(meta: P2PFileMeta, forceMemory: boolean): Promise<void> {
    if (!this.options.storage.hasCurrent) await this.options.storage.initialize(meta, forceMemory)
  }

  async append(position: number, chunk: ArrayBuffer): Promise<void> {
    await this.options.storage.append(position, chunk)
  }

  async checkpointData({ meta, receivedBytes, completedHashes }: ReceiverCheckpointSnapshot, force = false) {
    if (
      this.options.storage.kind !== "persistent" ||
      receivedBytes <= 0 ||
      receivedBytes >= meta.size ||
      (!force &&
        this.#lastCheckpointBytes > 0 &&
        receivedBytes - this.#lastCheckpointBytes < p2pCheckpointIntervalBytes)
    ) {
      return
    }
    await this.options.storage.checkpoint()
    const checkpoint: P2PResumeCheckpoint = {
      version: 1,
      roomName: this.options.roomName,
      peerId: this.options.peerId,
      storageId: this.options.storage.id,
      meta,
      receivedBytes,
      completedHashes,
      updatedAt: Date.now(),
    }
    if (!writeP2PResumeCheckpoint(checkpoint)) return
    this.#checkpoint = checkpoint
    this.#lastCheckpointBytes = receivedBytes
    this.#registerCheckpoint()
  }

  async reset(clearData: () => void): Promise<void> {
    await this.enqueue(async () => {
      if (this.#checkpoint || this.#registration !== "unregistered") {
        this.#pendingClear = !this.options.sendSignal({ type: "transfer-checkpoint-clear" })
      }
      await this.#discardCurrent()
      clearData()
    })
  }

  async replaceBlock(index: number, parts: ArrayBuffer[]): Promise<void> {
    await this.enqueue(() => this.options.storage.replaceBlock(index, parts))
  }

  async file(meta: P2PFileMeta): Promise<File> {
    return await this.enqueue(() => this.options.storage.file(meta))
  }

  verificationParts(index: number): readonly ArrayBuffer[] | undefined {
    return this.options.storage.verificationParts(index)
  }

  archiveCurrent(): void {
    this.options.storage.archiveCurrent()
  }

  rotateId(): void {
    this.options.storage.rotateId()
  }

  async restore(receivedBytes: number, completedHashBytes: number): Promise<ArrayBuffer> {
    return await this.options.storage.restore(receivedBytes, completedHashBytes)
  }

  clearCheckpoint(): void {
    this.#clearCheckpoint()
  }

  queueDeletion(preserveCurrent: boolean): void {
    this.options.storage.queueDeletion(preserveCurrent)
  }

  async preserveOrDispose(
    receivedBytes: number,
    complete: boolean,
    clearData: () => void,
    discardCompleted = false,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (this.options.storage.kind === "persistent" && this.#checkpoint && receivedBytes > 0 && !complete) {
        await this.options.storage.preserveCurrent()
        clearData()
      } else {
        await this.#discardCurrent()
        clearData()
      }
      if (discardCompleted) await this.options.storage.discardCompleted()
    })
  }

  onSignalingOpen(): void {
    this.#registration = "unregistered"
  }

  onSignalingReady(): void {
    if (this.#pendingClear && this.options.sendSignal({ type: "transfer-checkpoint-clear" })) {
      this.#pendingClear = false
    }
    this.#registerCheckpoint()
  }

  onRegistrationResult(accepted: boolean): void {
    this.#registration = this.#checkpoint && accepted && !this.#pendingClear ? "registered" : "unregistered"
  }

  registerCheckpoint(): void {
    this.#registerCheckpoint()
  }

  #registerCheckpoint(): void {
    if (!this.#checkpoint || this.#registration !== "unregistered") return
    if (this.options.sendSignal({ type: "transfer-checkpoint" })) this.#registration = "pending"
  }

  async #discardCurrent(): Promise<void> {
    this.#clearCheckpoint()
    await this.options.storage.discardCurrent()
  }

  #clearCheckpoint(): void {
    this.#checkpoint = undefined
    this.#registration = "unregistered"
    this.#lastCheckpointBytes = 0
    removeP2PResumeCheckpoint(this.options.roomName)
  }
}
