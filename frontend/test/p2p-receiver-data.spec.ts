import { describe, expect, it, vi } from "vitest"
import { ReceiverDataSession } from "../utils/p2p/receiverDataSession.js"
import { ReceiverTransferLifecycle } from "../utils/p2p/receiverSession.js"
import { ReceiverVerificationState } from "../utils/p2p/receiverVerification.js"
import type { ReceiverStorageCoordinator } from "../utils/p2p/receiverStorageCoordinator.js"
import { receiveAckIntervalBytes } from "../utils/p2p/transfer.js"

function fixture(append: (chunk: ArrayBuffer) => Promise<void>) {
  const meta = {
    revision: "test-revision",
    name: "file.bin",
    size: receiveAckIntervalBytes * 2,
    type: "",
    lastModified: 0,
    senderBrowser: "test",
    verifyTransfer: false,
  }
  const transfer = new ReceiverTransferLifecycle()
  transfer.transition({ kind: "downloading" })
  const sendProgress = vi.fn()
  const callbacks = { onProgress: vi.fn(), onStatus: vi.fn(), onError: vi.fn() }
  const onComplete = vi.fn()
  const storage = {
    enqueue: <T>(operation: () => Promise<T>) => operation(),
    initialize: () => Promise.resolve(),
    append: (_position: number, chunk: ArrayBuffer) => append(chunk),
    checkpointData: vi.fn(() => Promise.resolve()),
    file: vi.fn(() => Promise.resolve(new File([new Uint8Array(meta.size)], meta.name))),
    reset: vi.fn((clear: () => void) => {
      clear()
      return Promise.resolve()
    }),
  }
  const onFailure = vi.fn(async () => session.discard())
  const session = new ReceiverDataSession({
    meta: () => meta,
    forceMemoryStorage: () => false,
    transfer,
    storage: storage as unknown as ReceiverStorageCoordinator,
    verification: new ReceiverVerificationState(),
    callbacks,
    send: sendProgress,
    transition: (next) => transfer.transition(next),
    onComplete,
    onFailure,
  })
  session.reset()
  return { session, sendProgress, storage, callbacks, onComplete, onFailure, meta }
}

describe("P2P receiver byte credits", () => {
  it("counts committed bytes when the storage worker detaches the input buffer", async () => {
    const { session, sendProgress, storage } = fixture(async (chunk) => {
      structuredClone(chunk, { transfer: [chunk] })
      await Promise.resolve()
    })
    await session.receive(new ArrayBuffer(receiveAckIntervalBytes), () => true)
    expect(session.receivedBytes).toBe(receiveAckIntervalBytes)
    expect(storage.checkpointData).toHaveBeenCalledWith(
      expect.objectContaining({ receivedBytes: receiveAckIntervalBytes }),
      false,
    )
    expect(sendProgress).toHaveBeenLastCalledWith({
      type: "progress",
      doneBytes: receiveAckIntervalBytes,
      revision: "test-revision",
      flowBytes: receiveAckIntervalBytes,
    })
  })

  it("does not grant byte credits to a replacement channel while an old write finishes", async () => {
    let release!: () => void
    const write = new Promise<void>((resolve) => (release = resolve))
    const { session, sendProgress } = fixture(() => write)
    let current = true
    const receiving = session.receive(new ArrayBuffer(receiveAckIntervalBytes), () => current)
    current = false
    release()
    await receiving
    expect(sendProgress).not.toHaveBeenCalled()
  })

  it("does not advance the receive offset or checkpoint after a failed storage write", async () => {
    const error = new Error("Disk full")
    const { session, sendProgress, storage } = fixture(() => Promise.reject(error))
    await expect(session.receive(new ArrayBuffer(receiveAckIntervalBytes), () => true)).rejects.toBe(error)
    expect(session.receivedBytes).toBe(0)
    expect(storage.checkpointData).not.toHaveBeenCalled()
    expect(sendProgress).not.toHaveBeenCalled()
  })

  it("does not complete a replacement channel while the old file is being finalized", async () => {
    const { session, meta, storage, onComplete } = fixture(() => Promise.resolve())
    await session.receive(new ArrayBuffer(meta.size), () => true)
    let release!: (file: File) => void
    storage.file.mockReturnValue(new Promise((resolve) => (release = resolve)))
    let current = true
    const finishing = session.finishTransfer(undefined, () => current)
    current = false
    release(new File([new Uint8Array(meta.size)], meta.name))
    await finishing
    expect(onComplete).not.toHaveBeenCalled()
  })

  it("discards a completed store whose size differs from the received file", async () => {
    const { session, meta, storage, onComplete, onFailure, callbacks } = fixture(() => Promise.resolve())
    await session.receive(new ArrayBuffer(meta.size), () => true)
    storage.file.mockResolvedValue(new File([new Uint8Array(meta.size - 1)], meta.name))
    await session.finishTransfer(undefined, () => true)
    expect(onFailure).toHaveBeenCalledWith(
      expect.stringContaining("Stored P2P file size mismatch"),
      expect.any(Function),
    )
    expect(session.receivedBytes).toBe(0)
    expect(onComplete).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.any(Error))
  })
})
