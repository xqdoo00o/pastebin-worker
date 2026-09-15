import { OPFS_LARGE_FILE_THRESHOLD_BYTES, OPFS_REQUIRED_SPACE_MULTIPLIER } from "../../../shared/constants.js"
import { verificationBlockSize, type P2PFileMeta } from "./protocol.js"
import { sliceArrayBuffer } from "./verification.js"
import { uuid } from "./transfer.js"
import {
  acquireOPFSFileLease,
  cleanupOPFSTemporaryFilesOnce,
  deleteOwnedOPFSFile,
  queueOPFSFileDeletion,
  type OPFSFileLease,
} from "../opfs.js"
import { P2PPersistentReceiveStore } from "../p2pReceiveStore.js"

export const MAX_MEMORY_P2P_BYTES = 1024 * 1024 * 1024

type OPFSStorageManager = StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }

interface OPFSReceivedFile {
  root: FileSystemDirectoryHandle
  filename: string
  handle: FileSystemFileHandle
  writable?: FileSystemWritableFileStream
  writePosition: number
  pendingParts: ArrayBuffer[]
  pendingBytes: number
  lease?: OPFSFileLease
}

export interface ReceivedStore {
  readonly kind: "memory" | "opfs" | "persistent"
  append(position: number, chunk: ArrayBuffer): Promise<void>
  replaceBlock(index: number, parts: ArrayBuffer[]): Promise<void>
  checkpoint(): Promise<void>
  file(meta: P2PFileMeta): Promise<File>
  verificationParts(index: number): readonly ArrayBuffer[] | undefined
  preserve(): Promise<void>
  queueDeletion(): void
  discard(): Promise<void>
}

class MemoryReceivedStore implements ReceivedStore {
  readonly kind = "memory" as const
  private blocks: ArrayBuffer[][] = []

  append(position: number, chunk: ArrayBuffer): Promise<void> {
    let chunkOffset = 0
    let writePosition = position
    while (chunkOffset < chunk.byteLength) {
      const blockIndex = Math.floor(writePosition / verificationBlockSize)
      const blockOffset = writePosition % verificationBlockSize
      const takeBytes = Math.min(verificationBlockSize - blockOffset, chunk.byteLength - chunkOffset)
      const part = sliceArrayBuffer(chunk, chunkOffset, chunkOffset + takeBytes)
      this.blocks[blockIndex] ??= []
      this.blocks[blockIndex].push(part)
      writePosition += part.byteLength
      chunkOffset += takeBytes
    }
    return Promise.resolve()
  }

  replaceBlock(index: number, parts: ArrayBuffer[]): Promise<void> {
    this.blocks[index] = parts
    return Promise.resolve()
  }

  checkpoint(): Promise<void> {
    return Promise.resolve()
  }

  file(meta: P2PFileMeta): Promise<File> {
    const file = new File(this.blocks.flat(), meta.name, { type: meta.type, lastModified: meta.lastModified })
    this.blocks = []
    return Promise.resolve(file)
  }

  verificationParts(index: number): readonly ArrayBuffer[] | undefined {
    return this.blocks[index]
  }

  preserve(): Promise<void> {
    return Promise.resolve()
  }

  queueDeletion(): void {
    // Memory-backed files do not need persistent cleanup.
  }

  discard(): Promise<void> {
    this.blocks = []
    return Promise.resolve()
  }
}

async function flushOPFSPendingParts(storage: OPFSReceivedFile): Promise<void> {
  if (storage.pendingBytes === 0) return
  if (!storage.writable) throw new Error("P2P temporary file is no longer writable.")
  const parts = storage.pendingParts
  const byteLength = storage.pendingBytes
  storage.pendingParts = []
  storage.pendingBytes = 0
  try {
    await storage.writable.write({ type: "write", position: storage.writePosition, data: new Blob(parts) })
    storage.writePosition += byteLength
  } catch (error) {
    storage.pendingParts = parts
    storage.pendingBytes = byteLength
    throw error
  }
}

function opfsStore(storage: OPFSReceivedFile): ReceivedStore {
  let fileRemoved = false
  const removeStoredFile = async () => {
    if (fileRemoved) return
    fileRemoved = await deleteOwnedOPFSFile(storage.root, storage.filename)
  }
  const discard = async () => {
    try {
      if (storage.writable) {
        await storage.writable.abort().catch(() => undefined)
        storage.writable = undefined
      }
      storage.pendingParts = []
      storage.pendingBytes = 0
      await removeStoredFile()
    } finally {
      storage.lease?.release()
    }
  }
  return {
    kind: "opfs",
    async append(_position, chunk) {
      storage.pendingParts.push(chunk)
      storage.pendingBytes += chunk.byteLength
      if (storage.pendingBytes >= verificationBlockSize) await flushOPFSPendingParts(storage)
    },
    async replaceBlock(index, parts) {
      await flushOPFSPendingParts(storage)
      if (!storage.writable) throw new Error("P2P temporary file is no longer writable.")
      await storage.writable.write({
        type: "write",
        position: index * verificationBlockSize,
        data: new Blob(parts),
      })
    },
    checkpoint: () => flushOPFSPendingParts(storage),
    async file(meta) {
      await flushOPFSPendingParts(storage)
      if (storage.writable) {
        await storage.writable.close()
        storage.writable = undefined
      }
      const storedFile = await storage.handle.getFile()
      return new File([storedFile], meta.name, { type: meta.type, lastModified: meta.lastModified })
    },
    verificationParts: () => undefined,
    preserve: discard,
    queueDeletion: () => queueOPFSFileDeletion(storage.filename),
    discard,
  }
}

function persistentReceivedStore(storage: P2PPersistentReceiveStore): ReceivedStore {
  return {
    kind: "persistent",
    append: (position, chunk) => storage.write(position, chunk),
    replaceBlock: (index, parts) => storage.replace(index * verificationBlockSize, parts),
    checkpoint: () => storage.flush(),
    file: (meta) => storage.file(meta),
    verificationParts: () => undefined,
    preserve: () => storage.preserve(),
    queueDeletion: () => storage.queueDeletion(),
    discard: () => storage.discard(),
  }
}

export class P2PReceiveStorageFactory {
  private readonly storageManager =
    typeof navigator === "undefined" ? undefined : (navigator.storage as OPFSStorageManager | undefined)
  private readonly opfsRootPromise =
    typeof this.storageManager?.getDirectory === "function"
      ? Promise.resolve(this.storageManager.getDirectory()).catch(() => undefined)
      : Promise.resolve(undefined)

  constructor(private readonly peerId: string) {
    void this.opfsRootPromise.then((root) => (root ? cleanupOPFSTemporaryFilesOnce(root) : 0))
  }

  canRestore(): boolean {
    return P2PPersistentReceiveStore.supported()
  }

  async restore(
    storageId: string,
    receivedBytes: number,
    completedHashBytes: number,
  ): Promise<{ store: ReceivedStore; tail: ArrayBuffer }> {
    const storage = new P2PPersistentReceiveStore(storageId)
    try {
      const { tail } = await storage.open(receivedBytes, completedHashBytes)
      return { store: persistentReceivedStore(storage), tail }
    } catch (error) {
      await storage.discard().catch(() => undefined)
      throw error
    }
  }

  async create(meta: P2PFileMeta, storageId: string, forceMemory: boolean): Promise<ReceivedStore> {
    if (!forceMemory && P2PPersistentReceiveStore.supported()) {
      const storage = new P2PPersistentReceiveStore(storageId)
      try {
        await storage.open(0, 0)
        return persistentReceivedStore(storage)
      } catch {
        await storage.discard().catch(() => undefined)
      }
    }

    const opfs = forceMemory ? undefined : await this.createOPFSFile(meta)
    if (opfs) return opfsStore(opfs)
    if (meta.size > MAX_MEMORY_P2P_BYTES) {
      throw new Error("This file is too large to receive without disk-backed browser storage.")
    }
    return new MemoryReceivedStore()
  }

  private async createOPFSFile(meta: P2PFileMeta): Promise<OPFSReceivedFile | undefined> {
    if (meta.size < OPFS_LARGE_FILE_THRESHOLD_BYTES || typeof this.storageManager?.getDirectory !== "function") {
      return undefined
    }
    const estimate = await this.storageManager.estimate().catch(() => undefined)
    if (estimate?.quota !== undefined) {
      const availableBytes = Math.max(0, estimate.quota - (estimate.usage ?? 0))
      if (availableBytes < meta.size * OPFS_REQUIRED_SPACE_MULTIPLIER) return undefined
    }

    let root: FileSystemDirectoryHandle | undefined
    const filename = `p2p-${Date.now()}-${this.peerId}-${uuid()}.tmp`
    let lease: OPFSFileLease | undefined
    try {
      root = await this.opfsRootPromise
      if (!root) return undefined
      const leaseRequest = acquireOPFSFileLease(filename)
      const acquiredLease = leaseRequest ? await leaseRequest : undefined
      if (acquiredLease === null) return undefined
      lease = acquiredLease
      const handle = await root.getFileHandle(filename, { create: true })
      const writable = await handle.createWritable({ keepExistingData: false })
      return {
        root,
        filename,
        handle,
        writable,
        writePosition: 0,
        pendingParts: [],
        pendingBytes: 0,
        lease,
      }
    } catch {
      if (root) await root.removeEntry(filename).catch(() => undefined)
      lease?.release()
      return undefined
    }
  }
}
