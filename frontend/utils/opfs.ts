import { acquireExclusiveWebLock, type WebLockLease } from "./webLock.js"
import { OPFS_LARGE_FILE_THRESHOLD_BYTES, OPFS_REQUIRED_SPACE_MULTIPLIER } from "../../shared/constants.js"
import {
  browserStorage,
  readStorageItem,
  removeStorageItem,
  setStorageItem,
  storageKeysWithPrefix,
} from "./browserStorage.js"

const tempFilePrefixes = {
  download: "paste-decrypt-",
  archive: "paste-archive-",
  optical: "paste-optical-",
} as const
export type OPFSTemporaryFilePurpose = keyof typeof tempFilePrefixes
const tempFileSuffix = ".tmp"
const tempFileMaxAgeMs = 24 * 60 * 60 * 1000
const downloadDeletionGraceMs = 60 * 60 * 1000
const pendingDeletionKeyPrefix = "pastebin-worker:opfs-delete:"
const managedTemporaryFilePattern = /^(?:paste-(?:decrypt|archive|optical)-|p2p-).+\.tmp$/

export const OPFS_DOWNLOAD_THRESHOLD = OPFS_LARGE_FILE_THRESHOLD_BYTES

type OPFSStorageManager = StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }

export type OPFSFileLease = WebLockLease

/** A file that may carry an application-managed backing-store lifecycle. */
export interface ManagedFile {
  file: File
  cleanup?: () => Promise<void>
  deferCleanup?: () => void
}

/** Successful result of closing an OPFS temporary file. */
export interface CompletedOPFSTemporaryFile extends ManagedFile {
  cleanup: () => Promise<void>
  deferCleanup: () => void
}

export interface OPFSTemporaryFile {
  write(data: FileSystemWriteChunkType): Promise<void>
  finish(filename: string, type: string): Promise<CompletedOPFSTemporaryFile>
  abort(): Promise<void>
}

const cleanupPromises = new WeakMap<FileSystemDirectoryHandle, Promise<number>>()

function opfsFileLockName(filename: string): string {
  return `pastebin-worker:opfs:${filename}`
}

function isManagedTemporaryFilename(filename: string): boolean {
  return managedTemporaryFilePattern.test(filename)
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError"
}

export function queueOPFSFileDeletion(filename: string): void {
  if (!isManagedTemporaryFilename(filename)) return
  setStorageItem(browserStorage("local"), `${pendingDeletionKeyPrefix}${filename}`, "1")
}

export function deferOPFSFileDeletion(filename: string, notBefore = Date.now() + downloadDeletionGraceMs): void {
  if (!isManagedTemporaryFilename(filename) || !Number.isFinite(notBefore)) {
    return
  }
  setStorageItem(
    browserStorage("local"),
    `${pendingDeletionKeyPrefix}${filename}`,
    String(Math.max(2, Math.ceil(notBefore))),
  )
}

export function clearQueuedOPFSFileDeletion(filename: string): void {
  if (!isManagedTemporaryFilename(filename)) return
  removeStorageItem(browserStorage("local"), `${pendingDeletionKeyPrefix}${filename}`)
}

function queuedOPFSFileDeletions(now = Date.now()): string[] {
  const storage = browserStorage("local")
  const filenames: string[] = []
  const invalidKeys: string[] = []
  for (const key of storageKeysWithPrefix(storage, pendingDeletionKeyPrefix)) {
    const filename = key.slice(pendingDeletionKeyPrefix.length)
    const rawNotBefore = readStorageItem(storage, key)
    const notBefore = rawNotBefore === "1" ? 0 : Number(rawNotBefore)
    if (!isManagedTemporaryFilename(filename) || !Number.isFinite(notBefore) || notBefore < 0) {
      invalidKeys.push(key)
    } else if (notBefore <= now) {
      filenames.push(filename)
    }
  }
  for (const key of invalidKeys) removeStorageItem(storage, key)
  return filenames
}

export function acquireOPFSFileLease(filename: string): Promise<OPFSFileLease | null> | undefined {
  return acquireExclusiveWebLock(opfsFileLockName(filename))
}

async function removeOPFSFileIfUnlocked(root: FileSystemDirectoryHandle, filename: string): Promise<boolean> {
  const leaseRequest = acquireOPFSFileLease(filename)
  // Without a cross-tab lock primitive, automatic deletion is not safe.
  if (!leaseRequest) return false
  const lease = await leaseRequest
  if (!lease) return false
  try {
    await root.removeEntry(filename)
    return true
  } catch (error) {
    return isNotFoundError(error)
  } finally {
    lease.release()
  }
}

export async function deleteOwnedOPFSFile(root: FileSystemDirectoryHandle, filename: string): Promise<boolean> {
  queueOPFSFileDeletion(filename)
  try {
    await root.removeEntry(filename)
    clearQueuedOPFSFileDeletion(filename)
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      clearQueuedOPFSFileDeletion(filename)
      return true
    }
    return false
  }
}

export async function cleanupQueuedOPFSFileDeletions(
  root: FileSystemDirectoryHandle,
  now = Date.now(),
): Promise<number> {
  let removed = 0
  for (const filename of queuedOPFSFileDeletions(now)) {
    if (!(await removeOPFSFileIfUnlocked(root, filename))) continue
    clearQueuedOPFSFileDeletion(filename)
    removed += 1
  }
  return removed
}

export async function cleanupStaleOPFSTemporaryFiles(
  root: FileSystemDirectoryHandle,
  now = Date.now(),
): Promise<number> {
  let removed = 0
  const staleBefore = now - tempFileMaxAgeMs
  for await (const [name, handle] of root.entries()) {
    if (!isManagedTemporaryFilename(name) || handle.kind !== "file") continue
    try {
      const file = await handle.getFile()
      if (file.lastModified <= staleBefore && (await removeOPFSFileIfUnlocked(root, name))) removed += 1
    } catch {
      // Cleanup is best-effort and must not prevent a new download.
    }
  }
  return removed
}

export function cleanupOPFSTemporaryFilesOnce(root: FileSystemDirectoryHandle): Promise<number> {
  const existing = cleanupPromises.get(root)
  if (existing) return existing
  const cleanup = cleanupQueuedOPFSFileDeletions(root)
    .then(async (removed) => removed + (await cleanupStaleOPFSTemporaryFiles(root)))
    .catch(() => 0)
  cleanupPromises.set(root, cleanup)
  return cleanup
}

export async function createOPFSTemporaryFile(
  expectedSize: number,
  purpose: OPFSTemporaryFilePurpose = "download",
): Promise<OPFSTemporaryFile> {
  const storage = navigator.storage as OPFSStorageManager | undefined
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("This browser does not support disk-backed large downloads (OPFS)")
  }

  const estimate = await storage.estimate().catch(() => undefined)
  if (estimate?.quota !== undefined) {
    const available = Math.max(0, estimate.quota - (estimate.usage ?? 0))
    if (available < expectedSize * OPFS_REQUIRED_SPACE_MULTIPLIER) {
      throw new Error("Not enough browser storage is available to store this file")
    }
  }

  const root = await storage.getDirectory()
  void cleanupOPFSTemporaryFilesOnce(root)
  const temporaryName = `${tempFilePrefixes[purpose]}${Date.now()}-${crypto.randomUUID()}${tempFileSuffix}`
  const leaseRequest = acquireOPFSFileLease(temporaryName)
  const lease = leaseRequest ? await leaseRequest : undefined
  if (lease === null) throw new Error("The OPFS temporary file is already in use")
  let handle: FileSystemFileHandle
  try {
    handle = await root.getFileHandle(temporaryName, { create: true })
  } catch (error) {
    lease?.release()
    throw error
  }
  let writable: FileSystemWritableFileStream | undefined
  try {
    writable = await handle.createWritable({ keepExistingData: false })
  } catch (error) {
    await root.removeEntry(temporaryName).catch(() => undefined)
    lease?.release()
    throw error
  }
  let settled = false
  let leaseReleased = false
  let disposal: "remove" | "defer" | undefined
  let removalPromise: Promise<void> | undefined

  const releaseLease = () => {
    if (leaseReleased) return
    leaseReleased = true
    lease?.release()
  }

  const remove = async () => {
    if (disposal === "defer") return
    disposal = "remove"
    removalPromise ??= (async () => {
      try {
        await deleteOwnedOPFSFile(root, temporaryName)
      } finally {
        releaseLease()
      }
    })()
    await removalPromise
  }

  const deferCleanup = () => {
    if (disposal) return
    disposal = "defer"
    deferOPFSFileDeletion(temporaryName)
    releaseLease()
  }

  return {
    async write(data) {
      if (!writable || settled) throw new Error("The temporary file is no longer writable")
      await writable.write(data)
    },
    async finish(filename, type) {
      if (!writable || settled) throw new Error("The temporary file is no longer writable")
      await writable.close()
      writable = undefined
      try {
        const storedFile = await handle.getFile()
        const file = new File([storedFile], filename, { type, lastModified: storedFile.lastModified })
        settled = true
        return { file, cleanup: remove, deferCleanup }
      } catch (error) {
        settled = true
        await remove()
        throw error
      }
    },
    async abort() {
      if (settled) return
      settled = true
      if (writable) await writable.abort().catch(() => undefined)
      writable = undefined
      await remove()
    },
  }
}
