import { afterEach, describe, expect, it, vi } from "vitest"
import { verificationBlockSize } from "../utils/p2p/protocol.js"
import { SenderFileVersionRegistry, createFileVersion } from "../utils/p2p/senderState.js"
import { ReceiverStorageSession, ReceiverTransferLifecycle } from "../utils/p2p/receiverSession.js"
import { ReceiverVerificationManifestCollector, ReceiverVerificationState } from "../utils/p2p/receiverVerification.js"
import type { ReceivedStore } from "../utils/p2p/receivedStorage.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("P2P sender file-version registry", () => {
  it("retains peer revisions until the reconnect grace period expires", async () => {
    vi.useFakeTimers()
    const firstCleanup = vi.fn(() => Promise.resolve())
    const first = createFileVersion(new File(["first"], "first.txt"), true, 0, undefined, firstCleanup)
    const registry = new SenderFileVersionRegistry(first, 100)
    registry.refsFor("peer-1").current = first

    const second = createFileVersion(new File(["second"], "second.txt"), true, 1)
    registry.setCurrent(second)
    registry.prune()
    await vi.advanceTimersByTimeAsync(100)
    expect(firstCleanup).not.toHaveBeenCalled()

    registry.releasePeer("peer-1")
    await vi.advanceTimersByTimeAsync(100)
    expect(firstCleanup).toHaveBeenCalledOnce()
    expect(registry.get(first.revision)).toBeUndefined()
    expect(registry.get(second.revision)).toBe(second)

    registry.dispose()
  })
})

describe("P2P receiver transfer lifecycle", () => {
  it("keeps stopping intent and pause state queries in one model", () => {
    const transfer = new ReceiverTransferLifecycle()
    expect(transfer.wantsDownload()).toBe(false)

    transfer.transition({ kind: "downloading" })
    expect(transfer.wantsDownload()).toBe(true)

    transfer.transition({ kind: "stopping", restartAfterStop: true })
    expect(transfer.isDiscarding()).toBe(true)
    expect(transfer.shouldRestartAfterStop()).toBe(true)

    transfer.transition({ kind: "complete" })
    expect(transfer.isComplete()).toBe(true)
    expect(transfer.shouldRestartAfterStop()).toBe(false)
  })
})

describe("P2P receiver storage session", () => {
  it("keeps completed and current stores under one cleanup owner", async () => {
    const completed = mockReceivedStore("persistent")
    const current = mockReceivedStore("memory")
    const stores = [completed.store, current.store]
    const factory = {
      canRestore: () => true,
      create: vi.fn(() => Promise.resolve(stores.shift()!)),
      restore: vi.fn(),
    }
    const storage = new ReceiverStorageSession(factory, "storage-1")
    const meta = {
      revision: "revision-1",
      name: "file.txt",
      size: 4,
      type: "text/plain",
      lastModified: 0,
      senderBrowser: "Test browser",
      verifyTransfer: false,
    }

    await storage.initialize(meta, false)
    storage.archiveCurrent()
    await storage.initialize(meta, true)
    storage.queueDeletion(false)

    expect(completed.queueDeletion).toHaveBeenCalledOnce()
    expect(current.queueDeletion).toHaveBeenCalledOnce()
    await storage.discardCompleted()
    await storage.discardCurrent()
    expect(completed.discard).toHaveBeenCalledOnce()
    expect(current.discard).toHaveBeenCalledOnce()
    expect(storage.id).not.toBe("storage-1")
  })
})

function mockReceivedStore(kind: ReceivedStore["kind"]) {
  const queueDeletion = vi.fn()
  const discard = vi.fn(() => Promise.resolve())
  const store: ReceivedStore = {
    kind,
    append: vi.fn(() => Promise.resolve()),
    replaceBlock: vi.fn(() => Promise.resolve()),
    checkpoint: vi.fn(() => Promise.resolve()),
    file: vi.fn(() => Promise.resolve(new File([], "file.txt"))),
    verificationParts: vi.fn(),
    preserve: vi.fn(() => Promise.resolve()),
    queueDeletion,
    discard,
  }
  return { store, queueDeletion, discard }
}

describe("P2P verification manifest collector", () => {
  it("assembles ordered chunks and validates the completed manifest", () => {
    const collector = new ReceiverVerificationManifestCollector()
    collector.start(verificationBlockSize * 2, verificationBlockSize, 2)
    collector.append(0, ["hash-0"])
    collector.append(1, ["hash-1"])

    expect(collector.finish(undefined, verificationBlockSize * 2)).toEqual({
      manifest: { blockSize: verificationBlockSize, hashes: ["hash-0", "hash-1"] },
    })
  })

  it("rejects out-of-order and incomplete manifests", () => {
    const collector = new ReceiverVerificationManifestCollector()
    collector.start(verificationBlockSize * 2, verificationBlockSize, 2)
    expect(() => collector.append(1, ["hash-1"])).toThrow("chunks are out of order")

    collector.clear()
    collector.start(verificationBlockSize * 2, verificationBlockSize, 2)
    collector.append(0, ["hash-0"])
    expect(collector.finish(undefined, verificationBlockSize * 2)).toEqual({
      error: "Transfer verification manifest length mismatch.",
    })
  })
})

describe("P2P receiver verification state", () => {
  it("owns manifest, retry, and repair-block state", async () => {
    const verification = new ReceiverVerificationState()
    verification.startManifest(3, verificationBlockSize, 1)
    verification.appendManifest(0, ["hash-0"])

    expect(verification.finishManifest(undefined, 3)).toEqual({
      manifest: { blockSize: verificationBlockSize, hashes: ["hash-0"] },
    })
    expect(verification.nextIncompleteRetry(2)).toBe(1)
    expect(verification.nextIncompleteRetry(2)).toBe(2)
    expect(verification.nextIncompleteRetry(2)).toBeUndefined()

    expect(verification.beginRepair([0], 2)).toBe(true)
    expect(verification.repairBytes(3)).toBe(3)
    verification.startRepairBlock(0, 3)
    await verification.appendRepairChunk(new ArrayBuffer(2))
    await verification.appendRepairChunk(new ArrayBuffer(1))

    const repaired = verification.finishRepairBlock(0)
    expect(repaired?.parts.map((part) => part.byteLength)).toEqual([2, 1])
    expect(verification.completeRepair(0, repaired?.repairedHash)).toEqual([0])
    expect(verification.hasRepairBlock).toBe(false)
  })

  it("rejects oversized and incomplete repair blocks", async () => {
    const verification = new ReceiverVerificationState()
    verification.startRepairBlock(2, 2)
    await expect(verification.appendRepairChunk(new ArrayBuffer(3))).rejects.toThrow("exceeds")
    expect(() => verification.finishRepairBlock(2)).toThrow("size mismatch")
    expect(verification.hasRepairBlock).toBe(false)
  })
})
