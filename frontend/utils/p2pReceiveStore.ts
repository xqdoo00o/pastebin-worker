import { isP2PFileMeta, isVerificationHash, verificationBlockSize, type P2PFileMeta } from "./p2p/protocol.js"
import { isUuid } from "../../shared/verify.js"
import {
  acquireOPFSFileLease,
  clearQueuedOPFSFileDeletion,
  deleteOwnedOPFSFile,
  queueOPFSFileDeletion,
  type OPFSFileLease,
} from "./opfs.js"
import { acquireExclusiveWebLock, type WebLockLease } from "./webLock.js"
import { WorkerRequestMap } from "./workerRequests.js"
import {
  browserStorage,
  readStorageJson,
  removeStorageItem,
  storageKeysWithPrefix,
  writeStorageJson,
} from "./browserStorage.js"

const checkpointSchemaVersion = 1
const sessionPeerSchemaVersion = 1
const checkpointKeyPrefix = "pastebin-worker:p2p-resume:"
const sessionPeerKeyPrefix = "pastebin-worker:p2p-peer:"
const checkpointMaxAgeMs = 24 * 60 * 60 * 1000
const sessionPeerMaxAgeMs = checkpointMaxAgeMs
export const p2pCheckpointIntervalBytes = 1024 * 1024
const persistentWriteBatchBytes = p2pCheckpointIntervalBytes

export interface P2PResumeCheckpoint {
  version: typeof checkpointSchemaVersion
  roomName: string
  peerId: string
  storageId?: string
  meta: P2PFileMeta
  receivedBytes: number
  completedHashes: string[]
  updatedAt: number
}

interface P2PSessionPeer {
  version: typeof sessionPeerSchemaVersion
  peerId: string
  recoveryRetryToken?: string
  updatedAt: number
}

export type P2PSessionPeerState = Pick<P2PSessionPeer, "peerId" | "recoveryRetryToken">

interface WorkerResponse {
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

interface OpenResult {
  tail: ArrayBuffer
}

function checkpointKey(roomName: string): string {
  return `${checkpointKeyPrefix}${roomName}`
}

function sessionPeerKey(roomName: string): string {
  return `${sessionPeerKeyPrefix}${roomName}`
}

function isCheckpoint(value: unknown, roomName: string, now = Date.now()): value is P2PResumeCheckpoint {
  if (typeof value !== "object" || value === null) return false
  const checkpoint = value as Partial<P2PResumeCheckpoint>
  return (
    checkpoint.version === checkpointSchemaVersion &&
    checkpoint.roomName === roomName &&
    isUuid(checkpoint.peerId) &&
    (checkpoint.storageId === undefined || isUuid(checkpoint.storageId)) &&
    isP2PFileMeta(checkpoint.meta) &&
    typeof checkpoint.receivedBytes === "number" &&
    Number.isSafeInteger(checkpoint.receivedBytes) &&
    checkpoint.receivedBytes > 0 &&
    checkpoint.receivedBytes < checkpoint.meta.size &&
    Array.isArray(checkpoint.completedHashes) &&
    checkpoint.completedHashes.every(isVerificationHash) &&
    checkpoint.completedHashes.length * verificationBlockSize <= checkpoint.receivedBytes &&
    (!checkpoint.meta.verifyTransfer ||
      checkpoint.receivedBytes - checkpoint.completedHashes.length * verificationBlockSize < verificationBlockSize) &&
    (checkpoint.meta.verifyTransfer || checkpoint.completedHashes.length === 0) &&
    typeof checkpoint.updatedAt === "number" &&
    Number.isFinite(checkpoint.updatedAt) &&
    checkpoint.updatedAt > now - checkpointMaxAgeMs &&
    checkpoint.updatedAt <= now + 60_000
  )
}

function isSessionPeer(value: unknown, now = Date.now()): value is P2PSessionPeer {
  if (typeof value !== "object" || value === null) return false
  const peer = value as Partial<P2PSessionPeer>
  return (
    peer.version === sessionPeerSchemaVersion &&
    isUuid(peer.peerId) &&
    (peer.recoveryRetryToken === undefined || isUuid(peer.recoveryRetryToken)) &&
    typeof peer.updatedAt === "number" &&
    Number.isFinite(peer.updatedAt) &&
    peer.updatedAt > now - sessionPeerMaxAgeMs &&
    peer.updatedAt <= now + 60_000
  )
}

function readSessionPeerValue(storage: Storage | undefined, key: string, now = Date.now()): P2PSessionPeer | undefined {
  return readStorageJson(storage, key, (value) => (isSessionPeer(value, now) ? value : undefined))
}

export function readP2PSessionPeer(roomName: string): P2PSessionPeerState | undefined {
  const storage = browserStorage("session")
  const key = sessionPeerKey(roomName)
  const peer = readSessionPeerValue(storage, key)
  if (peer) return { peerId: peer.peerId, recoveryRetryToken: peer.recoveryRetryToken }
  removeStorageItem(storage, key)
  return undefined
}

export function writeP2PSessionPeer(roomName: string, peerId: string): boolean {
  if (!isUuid(peerId)) return false
  const storage = browserStorage("session")
  const key = sessionPeerKey(roomName)
  const existing = readSessionPeerValue(storage, key)
  const peer: P2PSessionPeer = {
    version: sessionPeerSchemaVersion,
    peerId,
    ...(existing?.peerId === peerId && existing.recoveryRetryToken
      ? { recoveryRetryToken: existing.recoveryRetryToken }
      : {}),
    updatedAt: Date.now(),
  }
  return writeStorageJson(storage, key, peer)
}

export function setP2PSessionRecoveryRetryToken(
  roomName: string,
  peerId: string,
  recoveryRetryToken: string | undefined,
): boolean {
  if (!isUuid(peerId) || (recoveryRetryToken !== undefined && !isUuid(recoveryRetryToken))) {
    return false
  }
  const storage = browserStorage("session")
  const key = sessionPeerKey(roomName)
  const existing = readSessionPeerValue(storage, key)
  if (existing?.peerId !== peerId) return false
  const peer: P2PSessionPeer = {
    version: sessionPeerSchemaVersion,
    peerId,
    ...(recoveryRetryToken ? { recoveryRetryToken } : {}),
    updatedAt: Date.now(),
  }
  return writeStorageJson(storage, key, peer)
}

export function cleanupStaleP2PSessionPeers(now = Date.now()): number {
  const storage = browserStorage("session")
  let removed = 0
  for (const key of storageKeysWithPrefix(storage, sessionPeerKeyPrefix)) {
    const roomName = key.slice(sessionPeerKeyPrefix.length)
    const peer = readSessionPeerValue(storage, key, now)
    if (roomName && peer) continue
    if (removeStorageItem(storage, key)) removed += 1
  }
  return removed
}

export function cleanupStaleP2PResumeCheckpoints(now = Date.now()): number {
  const storage = browserStorage("local")
  let removed = 0
  for (const key of storageKeysWithPrefix(storage, checkpointKeyPrefix)) {
    const roomName = key.slice(checkpointKeyPrefix.length)
    const checkpoint = readStorageJson(storage, key, (value) =>
      roomName && isCheckpoint(value, roomName, now) ? value : undefined,
    )
    if (checkpoint) continue
    if (removeStorageItem(storage, key)) removed += 1
  }
  return removed
}

export function readP2PResumeCheckpoint(roomName: string): P2PResumeCheckpoint | undefined {
  const storage = browserStorage("local")
  const key = checkpointKey(roomName)
  const checkpoint = readStorageJson(storage, key, (value) => (isCheckpoint(value, roomName) ? value : undefined))
  if (checkpoint) return checkpoint
  removeStorageItem(storage, key)
  return undefined
}

export function writeP2PResumeCheckpoint(checkpoint: P2PResumeCheckpoint): boolean {
  writeP2PSessionPeer(checkpoint.roomName, checkpoint.peerId)
  return writeStorageJson(browserStorage("local"), checkpointKey(checkpoint.roomName), checkpoint)
}

export function removeP2PResumeCheckpoint(roomName: string): void {
  removeStorageItem(browserStorage("local"), checkpointKey(roomName))
}

export function p2pResumeMetaMatches(left: P2PFileMeta, right: P2PFileMeta): boolean {
  return (
    left.revision === right.revision &&
    left.name === right.name &&
    left.size === right.size &&
    left.type === right.type &&
    left.lastModified === right.lastModified &&
    left.verifyTransfer === right.verifyTransfer
  )
}

export class P2PPersistentReceiveStore {
  private readonly worker: Worker
  private readonly requests = new WorkerRequestMap<unknown>()
  private closed = false
  private closeError: Error | undefined
  private pendingWritePosition: number | undefined
  private pendingWriteParts: ArrayBuffer[] = []
  private pendingWriteBytes = 0
  private fileRemoved = false
  private fileLease: OPFSFileLease | undefined

  constructor(private readonly storageId: string) {
    this.worker = new Worker(new URL("./p2pStorage.worker.ts", import.meta.url), {
      type: "module",
      name: "p2p-receive-store",
    })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      if (response.ok) this.requests.resolve(response.id, response.value)
      else this.requests.reject(response.id, new Error(response.error || "P2P storage worker failed."))
    }
    this.worker.onerror = () => this.failWorker(new Error("P2P storage worker failed."))
    this.worker.onmessageerror = () => this.failWorker(new Error("P2P storage worker returned an invalid message."))
  }

  static supported(): boolean {
    return (
      typeof Worker !== "undefined" &&
      typeof navigator !== "undefined" &&
      typeof (navigator.storage as (StorageManager & { getDirectory?: unknown }) | undefined)?.getDirectory ===
        "function"
    )
  }

  async open(checkpointBytes: number, tailOffset: number): Promise<OpenResult> {
    const leaseRequest = acquireOPFSFileLease(this.filename())
    const lease = leaseRequest ? await leaseRequest : undefined
    if (lease === null) throw new Error("The saved P2P temporary file is already in use.")
    this.fileLease = lease
    try {
      return (await this.request("open", { peerId: this.storageId, checkpointBytes, tailOffset })) as OpenResult
    } catch (error) {
      this.releaseFileLease()
      throw error
    }
  }

  async write(position: number, data: ArrayBuffer): Promise<void> {
    if (this.pendingWritePosition === undefined) this.pendingWritePosition = position
    const expectedPosition = this.pendingWritePosition + this.pendingWriteBytes
    if (position !== expectedPosition) {
      await this.flushPendingWrite()
      this.pendingWritePosition = position
    }
    this.pendingWriteParts.push(data)
    this.pendingWriteBytes += data.byteLength
    if (this.pendingWriteBytes >= persistentWriteBatchBytes) await this.flushPendingWrite()
  }

  async replace(position: number, parts: ArrayBuffer[]): Promise<void> {
    await this.flushPendingWrite()
    await this.request("write", { position, parts }, parts)
  }

  async flush(): Promise<void> {
    await this.flushPendingWrite()
    await this.request("flush")
  }

  async file(meta: P2PFileMeta): Promise<File> {
    await this.closeHandle()
    try {
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(this.filename())
      const file = await handle.getFile()
      // OPFS-backed File objects are lazy in Chromium. Removing their entry here can
      // make a later preview or object-URL download fail with NotFoundError.
      return new File([file], meta.name, { type: meta.type, lastModified: meta.lastModified })
    } finally {
      this.terminate()
    }
  }

  async preserve(): Promise<void> {
    try {
      await this.closeHandle()
    } finally {
      this.terminate()
      this.releaseFileLease()
    }
  }

  queueDeletion(): void {
    queueOPFSFileDeletion(this.filename())
  }

  async discard(): Promise<void> {
    this.queueDeletion()
    this.clearPendingWrite()
    if (this.closed) {
      try {
        const root = await navigator.storage.getDirectory()
        await this.removeStoredFile(root)
      } finally {
        this.terminate()
        this.releaseFileLease()
      }
      return
    }
    try {
      await this.request("discard")
      this.fileRemoved = true
      clearQueuedOPFSFileDeletion(this.filename())
    } finally {
      this.terminate()
      this.releaseFileLease()
    }
  }

  private filename(): string {
    return `p2p-${this.storageId}.tmp`
  }

  private releaseFileLease(): void {
    this.fileLease?.release()
    this.fileLease = undefined
  }

  private async removeStoredFile(root: FileSystemDirectoryHandle): Promise<void> {
    if (this.fileRemoved) return
    this.fileRemoved = await deleteOwnedOPFSFile(root, this.filename())
  }

  private async closeHandle(): Promise<void> {
    if (this.closed) return
    await this.flushPendingWrite()
    await this.request("close")
    this.closed = true
  }

  private async flushPendingWrite(): Promise<void> {
    if (this.pendingWriteBytes === 0 || this.pendingWritePosition === undefined) return
    const position = this.pendingWritePosition
    const parts = this.pendingWriteParts
    this.clearPendingWrite()
    await this.request("write", { position, parts }, parts)
  }

  private clearPendingWrite(): void {
    this.pendingWritePosition = undefined
    this.pendingWriteParts = []
    this.pendingWriteBytes = 0
  }

  private request(
    type: string,
    payload: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("P2P storage worker is closed."))
    return this.requests.request((id) => this.worker.postMessage({ id, type, ...payload }, transfer))
  }

  private failWorker(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeError = error
    this.clearPendingWrite()
    this.worker.terminate()
    this.requests.rejectAll(error)
  }

  private terminate(): void {
    this.closed = true
    this.clearPendingWrite()
    this.worker.terminate()
    this.requests.rejectAll(new Error("P2P storage worker closed."))
  }
}

export function acquireP2PReceiverRoomLock(roomName: string): Promise<WebLockLease | null> | undefined {
  return acquireExclusiveWebLock(`pastebin-worker:p2p-receiver-room:${roomName}`)
}
