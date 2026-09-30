import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ReceiverTransferCoordinator } from "../optical/receive/receiver-transfer.js"
import { OpticalReceiverRuntime, ReceivedFileResource, ReceiverSession } from "../optical/receive/receiver-runtime.js"
import type { OpticalFile } from "../optical/shared/protocol.js"
import type { StoredOpticalTransfer } from "../optical/receive/part-assembler.js"
import type { ReceiveMode } from "../optical/receive/receiver-view.js"

const mocks = vi.hoisted(() => ({ unpackFile: vi.fn(), ensureXXHashReady: vi.fn(), ensureZstdDecoderReady: vi.fn() }))
vi.mock("../optical/shared/protocol.js", () => ({ unpackFile: mocks.unpackFile }))
vi.mock("../wasm/xxhash-loader.js", () => ({ ensureXXHashReady: mocks.ensureXXHashReady }))
vi.mock("../wasm/zstd-loader.js", () => ({ ensureZstdDecoderReady: mocks.ensureZstdDecoderReady }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const part = { index: 1, count: 1, transferId: 1n }
const file: OpticalFile = {
  name: "received.bin",
  type: "application/octet-stream",
  bytes: new Uint8Array([1]),
  compression: "none",
  transmittedSize: 1,
  part,
}

function harness() {
  const session = new ReceiverSession<ReceiveMode>("camera")
  session.beginAttempt()
  const receivedFile = new ReceivedFileResource()
  const cleanup = vi.fn(() => Promise.resolve())
  const stored: StoredOpticalTransfer = {
    file: new File(["x"], "received.bin"),
    cleanup,
    deferCleanup: vi.fn(),
    transmittedSize: 1,
    wasCompressed: false,
  }
  const accept = vi.fn<() => Promise<StoredOpticalTransfer | undefined>>().mockResolvedValue(stored)
  const patch = vi.fn()
  const releaseDecodeWorkers = vi.fn()
  const resetReceiver = vi.fn()
  const showError = vi.fn()
  const suspendReceiver = vi.fn(() => Promise.resolve())
  const coordinator = new ReceiverTransferCoordinator({
    progressBar: document.createElement("div"),
    runtime: new OpticalReceiverRuntime(),
    session,
    view: { patch, patchProgress: vi.fn(), showError } as never,
    assembler: {
      assertCompatibleTransfer: vi.fn(),
      accept,
      reset: () => Promise.resolve(),
      progress: () => undefined,
      expectedTransfer: () => undefined,
    } as never,
    fountainClient: { expectTransfer: vi.fn() } as never,
    receivedFile,
    releaseDecodeWorkers,
    resetReceiver,
    suspendReceiver,
    renderReceiverStatus: vi.fn(),
    offerRetry: vi.fn(),
    teardownReceiver: () => Promise.resolve(),
  })
  const start = () =>
    coordinator.handleMessage({
      type: "complete",
      container: new ArrayBuffer(1),
      part,
      snapshot: { identity: "transfer", k: 1, symbolLen: 1, framesNew: 1 },
    })
  const dispose = () => {
    session.invalidate()
    receivedFile.release()
    coordinator.resetParts()
    patch.mockClear()
  }
  return {
    start,
    dispose,
    session,
    receivedFile,
    stored,
    cleanup,
    accept,
    patch,
    releaseDecodeWorkers,
    resetReceiver,
    showError,
    suspendReceiver,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.unpackFile.mockReset().mockResolvedValue(file)
  mocks.ensureXXHashReady.mockReset().mockResolvedValue(undefined)
  mocks.ensureZstdDecoderReady.mockReset().mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe("optical result completion lifecycle", () => {
  it("retains a current completed file until its owner releases it", async () => {
    const h = harness()
    h.start()
    await vi.runAllTimersAsync()
    expect(h.patch).toHaveBeenCalledWith({
      introVisible: false,
      settingsVisible: false,
      result: {
        kind: "file",
        file: h.stored.file,
        containerBytes: 1,
        seconds: 0,
        wasCompressed: false,
        stored: true,
      },
    })
    expect(h.cleanup).not.toHaveBeenCalled()
    h.receivedFile.release()
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it("does not suspend a new receiver after disposal during the progress animation", async () => {
    const h = harness()
    h.start()
    h.dispose()
    await vi.runAllTimersAsync()
    expect(h.suspendReceiver).not.toHaveBeenCalled()
    expect(h.accept).not.toHaveBeenCalled()
    expect(h.patch).not.toHaveBeenCalled()
  })

  it.each(["resolve", "reject"] as const)("ignores a late unpack %s after a mode transition", async (outcome) => {
    const pending = deferred<OpticalFile>()
    mocks.unpackFile.mockReturnValue(pending.promise)
    const h = harness()
    h.start()
    await vi.runAllTimersAsync()
    h.session.beginModeTransition("screen")
    h.session.reset()
    h.patch.mockClear()
    if (outcome === "resolve") pending.resolve(file)
    else pending.reject(new Error("old unpack failure"))
    await vi.runAllTimersAsync()
    expect(h.accept).not.toHaveBeenCalled()
    expect(h.patch).not.toHaveBeenCalled()
    expect(h.releaseDecodeWorkers).not.toHaveBeenCalled()
    expect(h.showError).not.toHaveBeenCalled()
  })

  it("does not start assembly when disposed while a codec is loading", async () => {
    const codec = deferred<void>()
    mocks.ensureXXHashReady.mockReturnValue(codec.promise)
    const h = harness()
    h.start()
    await vi.runAllTimersAsync()
    expect(mocks.ensureXXHashReady).toHaveBeenCalledOnce()
    h.dispose()
    codec.resolve()
    await vi.runAllTimersAsync()
    expect(h.accept).not.toHaveBeenCalled()
    expect(h.patch).not.toHaveBeenCalled()
  })

  it("deletes a completed temporary file returned after disposal", async () => {
    const assembly = deferred<StoredOpticalTransfer>()
    const h = harness()
    h.accept.mockReturnValue(assembly.promise)
    h.start()
    await vi.runAllTimersAsync()
    expect(h.accept).toHaveBeenCalledOnce()
    h.dispose()
    assembly.resolve(h.stored)
    await vi.runAllTimersAsync()
    expect(h.cleanup).toHaveBeenCalledOnce()
    expect(h.patch).not.toHaveBeenCalled()
    expect(h.releaseDecodeWorkers).not.toHaveBeenCalled()
    h.receivedFile.release()
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it("does not reset or report errors into a newer attempt when old assembly rejects", async () => {
    const assembly = deferred<StoredOpticalTransfer>()
    const h = harness()
    h.accept.mockReturnValue(assembly.promise)
    h.start()
    await vi.runAllTimersAsync()
    h.session.reset()
    h.patch.mockClear()
    assembly.reject(new Error("old assembly failed"))
    await vi.runAllTimersAsync()
    expect(h.patch).not.toHaveBeenCalled()
    expect(h.resetReceiver).not.toHaveBeenCalled()
    expect(h.releaseDecodeWorkers).not.toHaveBeenCalled()
    expect(h.showError).not.toHaveBeenCalled()
  })
})
