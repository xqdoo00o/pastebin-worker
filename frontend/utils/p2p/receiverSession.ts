import {
  cleanupStaleP2PResumeCheckpoints,
  cleanupStaleP2PSessionPeers,
  readP2PResumeCheckpoint,
  readP2PSessionPeer,
  writeP2PSessionPeer,
} from "../p2pReceiveStore.js"
import type { P2PFileMeta } from "./protocol.js"
import { P2PReceiveStorageFactory, type ReceivedStore } from "./receivedStorage.js"
import { uuid } from "./transfer.js"

type ReceiveStorageFactory = Pick<P2PReceiveStorageFactory, "canRestore" | "create" | "restore">

/** Owns the current receive store plus completed stores retained for history cards. */
export class ReceiverStorageSession {
  #current: ReceivedStore | undefined
  readonly #completed: ReceivedStore[] = []

  constructor(
    private readonly factory: ReceiveStorageFactory,
    private storageId: string,
  ) {}

  get id(): string {
    return this.storageId
  }

  get kind(): ReceivedStore["kind"] | undefined {
    return this.#current?.kind
  }

  get hasCurrent(): boolean {
    return this.#current !== undefined
  }

  canRestore(): boolean {
    return this.factory.canRestore()
  }

  async initialize(meta: P2PFileMeta, forceMemory: boolean): Promise<void> {
    this.#current ??= await this.factory.create(meta, this.storageId, forceMemory)
  }

  async restore(receivedBytes: number, completedHashBytes: number): Promise<ArrayBuffer> {
    const restored = await this.factory.restore(this.storageId, receivedBytes, completedHashBytes)
    this.#current = restored.store
    return restored.tail
  }

  async append(position: number, chunk: ArrayBuffer): Promise<void> {
    await this.#requiredCurrent().append(position, chunk)
  }

  async checkpoint(): Promise<void> {
    await this.#requiredCurrent().checkpoint()
  }

  async replaceBlock(index: number, parts: ArrayBuffer[]): Promise<void> {
    await this.#requiredCurrent().replaceBlock(index, parts)
  }

  async file(meta: P2PFileMeta): Promise<File> {
    return await this.#requiredCurrent().file(meta)
  }

  verificationParts(index: number): readonly ArrayBuffer[] | undefined {
    return this.#current?.verificationParts(index)
  }

  archiveCurrent(): void {
    if (!this.#current) return
    this.#completed.push(this.#current)
    this.#current = undefined
  }

  async discardCurrent(): Promise<void> {
    const storage = this.#current
    this.#current = undefined
    this.storageId = uuid()
    await storage?.discard().catch(() => undefined)
  }

  async preserveCurrent(): Promise<void> {
    const storage = this.#current
    this.#current = undefined
    await storage?.preserve().catch(() => undefined)
  }

  rotateId(): void {
    this.storageId = uuid()
  }

  queueDeletion(preserveCurrent: boolean): void {
    if (!preserveCurrent) this.#current?.queueDeletion()
    for (const storage of this.#completed) storage.queueDeletion()
  }

  async discardCompleted(): Promise<void> {
    const completed = this.#completed.splice(0)
    await Promise.all(completed.map((storage) => storage.discard().catch(() => undefined)))
  }

  #requiredCurrent(): ReceivedStore {
    if (!this.#current) throw new Error("P2P receive storage is unavailable.")
    return this.#current
  }
}

export type ReceiverTransferState =
  | { kind: "idle" }
  | { kind: "downloading" }
  | { kind: "pausing" }
  | { kind: "paused" }
  | { kind: "stopping"; restartAfterStop: boolean }
  | { kind: "verifying" }
  | { kind: "repairing" }
  | { kind: "complete" }

/** Keeps receiver transfer-state queries consistent across UI, RTC and storage paths. */
export class ReceiverTransferLifecycle {
  #state: ReceiverTransferState = { kind: "idle" }

  get state(): ReceiverTransferState {
    return this.#state
  }

  transition(next: ReceiverTransferState): void {
    this.#state = next
  }

  isComplete(): boolean {
    return this.#state.kind === "complete"
  }

  isDiscarding(): boolean {
    return this.#state.kind === "stopping"
  }

  wantsDownload(): boolean {
    return this.#state.kind === "downloading"
  }

  isPaused(): boolean {
    return this.#state.kind === "paused"
  }

  isPausePending(): boolean {
    return this.#state.kind === "pausing"
  }

  isRepairing(): boolean {
    return this.#state.kind === "repairing"
  }

  shouldRestartAfterStop(): boolean {
    return this.#state.kind === "stopping" && this.#state.restartAfterStop
  }
}

/** Immutable identity and storage chosen for one receiver session. */
export function createReceiverSessionIdentity(roomName: string) {
  cleanupStaleP2PResumeCheckpoints()
  cleanupStaleP2PSessionPeers()
  const checkpoint = readP2PResumeCheckpoint(roomName)
  const previousPeer = readP2PSessionPeer(roomName)
  const peerId = checkpoint?.peerId ?? previousPeer?.peerId ?? uuid()
  const initialRecoveryRetryToken = previousPeer?.peerId === peerId ? previousPeer.recoveryRetryToken : undefined
  writeP2PSessionPeer(roomName, peerId)

  return {
    checkpoint,
    initialRecoveryRetryToken,
    peerId,
    storage: new ReceiverStorageSession(
      new P2PReceiveStorageFactory(peerId),
      checkpoint?.storageId ?? (checkpoint ? peerId : uuid()),
    ),
  }
}

/** A completed/abandoned room must not reuse its receiver identity on the next visit. */
export function rotateReceiverSessionPeer(roomName: string): void {
  writeP2PSessionPeer(roomName, uuid())
}
