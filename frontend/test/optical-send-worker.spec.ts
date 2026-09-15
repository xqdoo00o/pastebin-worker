import { afterEach, describe, expect, it, vi } from "vitest"
import type { SenderWorkerInput, SenderWorkerOutput } from "../optical/shared/worker-messages.js"
import type {
  OpticalMemoryFile,
  PreparedOpticalTransfer,
  PrepareOpticalTransferOptions,
} from "../optical/send/prepared-transfer.js"
import { monochromeByteLength } from "../optical/shared/monochrome.js"

describe("optical sender worker configuration", () => {
  afterEach(() => {
    vi.doUnmock("../optical/shared/nanorq-runtime.js")
    vi.doUnmock("../wasm/zstd-runtime.js")
    vi.doUnmock("../wasm/xxhash-runtime.js")
    vi.doUnmock("../optical/send/prepared-transfer.js")
    vi.doUnmock("../optical/shared/qr-frame-encoder.js")
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("reuses its RaptorQ encoder across playback-only session changes", async () => {
    const free = vi.fn()
    const construct = vi.fn()
    const encode = vi.fn((_sequence: number) => ({ size: 21, packed: new Uint8Array(Math.ceil((21 * 21) / 8)) }))
    class MockFrameEncoder {
      readonly version = 1
      readonly modules = 21
      readonly k = 100

      constructor() {
        construct()
      }

      free(): void {
        free()
      }

      encode(sequence: number) {
        return encode(sequence)
      }
    }

    vi.doMock("../optical/shared/nanorq-runtime.js", () => ({
      initializeNanoRQ: () => Promise.resolve(),
    }))
    vi.doMock("../wasm/zstd-runtime.js", () => ({
      initializeZstdEncoder: () => Promise.resolve(),
    }))
    vi.doMock("../wasm/xxhash-runtime.js", () => ({ initializeXXHash: () => Promise.resolve() }))
    const getPart = vi.fn((index: number) =>
      Promise.resolve({
        container: Uint8Array.of(index + 1),
        containerTag: BigInt(index + 1),
        compression: "none" as const,
        originalSize: 1,
        transmittedSize: 1,
        part: { index, count: 2, transferId: 1n },
      }),
    )
    const cleanup = vi.fn(() => Promise.resolve())
    const prepareOpticalTransfer = vi.fn<
      (file: File | OpticalMemoryFile, options?: PrepareOpticalTransferOptions) => Promise<PreparedOpticalTransfer>
    >(() =>
      Promise.resolve({
        summary: {
          containerSize: 1,
          compression: "none",
          originalSize: 1,
          transmittedSize: 1,
          partCount: 3,
        },
        getPart,
        cleanup,
      }),
    )
    vi.doMock("../optical/send/prepared-transfer.js", () => ({
      prepareOpticalTransfer,
    }))
    vi.doMock("../optical/shared/qr-frame-encoder.js", () => ({
      OpticalQrFrameEncoder: MockFrameEncoder,
    }))

    const postMessage = vi.fn<(message: SenderWorkerOutput, transfer?: Transferable[]) => void>()
    const workerScope: {
      onmessage: ((event: MessageEvent<SenderWorkerInput>) => void) | null
      postMessage: typeof postMessage
    } = { onmessage: null, postMessage }
    vi.stubGlobal("self", workerScope)
    await import("../optical/send/worker.js")

    const dispatch = (data: SenderWorkerInput) => workerScope.onmessage?.({ data } as MessageEvent<SenderWorkerInput>)
    dispatch({ type: "init", wasmModule: {}, xxhashWasmModule: {} })
    const data = Uint8Array.of(1).buffer
    dispatch({ type: "prepareBytes", name: "payload.bin", mediaType: "application/octet-stream", data })
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "prepared" })))
    expect(prepareOpticalTransfer).toHaveBeenCalledOnce()
    expect(prepareOpticalTransfer.mock.calls[0]?.[0]).toEqual({
      name: "payload.bin",
      type: "application/octet-stream",
      data,
    })
    expect(getPart).not.toHaveBeenCalled()

    dispatch({ type: "configure", session: 1, frameBytes: 1000, ecc: "L" })
    await vi.waitFor(() => expect(construct).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(getPart.mock.calls.map(([index]) => index)).toEqual([0, 1]))

    // FPS and grid live outside the codec message; the UI restarts with a new
    // session carrying the same payload shape and ECC.
    dispatch({ type: "configure", session: 2, frameBytes: 1000, ecc: "L" })
    await vi.waitFor(() => expect(construct).toHaveBeenCalledOnce())
    expect(free).not.toHaveBeenCalled()

    // A playback-only change (FPS or grid layout) does not rebuild the
    // expensive RaptorQ encoder for the same payload shape and ECC.
    dispatch({ type: "configure", session: 3, frameBytes: 1000, ecc: "L" })
    await vi.waitFor(() => expect(construct).toHaveBeenCalledOnce())
    expect(free).not.toHaveBeenCalled()

    dispatch({ type: "generate", session: 3, count: 2, recycledBuffers: [] })
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "batch", session: 3 }),
        expect.any(Array),
      ),
    )
    expect(encode.mock.calls.map(([sequence]) => sequence)).toEqual([0, 1])
    const batch = postMessage.mock.calls.map(([message]) => message).find((message) => message.type === "batch")
    expect(batch?.type === "batch" ? batch.monochromeBuffers[0]?.byteLength : 0).toBe(monochromeByteLength(29, 29))

    dispatch({ type: "configure", session: 4, frameBytes: 1465, ecc: "L" })
    await vi.waitFor(() => expect(construct).toHaveBeenCalledTimes(2))
    expect(free).toHaveBeenCalledOnce()

    dispatch({ type: "dispose" })
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "disposed" }))
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it("aborts an obsolete next-part prefetch before loading a requested part", async () => {
    class MockFrameEncoder {
      readonly version = 1
      readonly modules = 21
      readonly k = 100
      readonly free = vi.fn()
    }

    vi.doMock("../optical/shared/nanorq-runtime.js", () => ({
      initializeNanoRQ: () => Promise.resolve(),
    }))
    vi.doMock("../wasm/zstd-runtime.js", () => ({
      initializeZstdEncoder: () => Promise.resolve(),
    }))
    vi.doMock("../wasm/xxhash-runtime.js", () => ({ initializeXXHash: () => Promise.resolve() }))
    const prefetchAborted = vi.fn()
    const packedPart = (index: number) => ({
      container: Uint8Array.of(index + 1),
      containerTag: BigInt(index + 1),
      compression: "none" as const,
      originalSize: 1,
      transmittedSize: 1,
      part: { index, count: 2, transferId: 1n },
    })
    const getPart = vi.fn((index: number, signal?: AbortSignal) => {
      if (index !== 1) return Promise.resolve(packedPart(index))
      return new Promise<ReturnType<typeof packedPart>>((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            prefetchAborted()
            reject(new DOMException("Prefetch cancelled", "AbortError"))
          },
          { once: true },
        )
      })
    })
    vi.doMock("../optical/send/prepared-transfer.js", () => ({
      prepareOpticalTransfer: () =>
        Promise.resolve({
          summary: {
            containerSize: 1,
            compression: "none",
            originalSize: 3,
            transmittedSize: 3,
            partCount: 3,
          },
          getPart,
          cleanup: () => Promise.resolve(),
        }),
    }))
    vi.doMock("../optical/shared/qr-frame-encoder.js", () => ({
      OpticalQrFrameEncoder: MockFrameEncoder,
    }))

    const postMessage = vi.fn<(message: SenderWorkerOutput, transfer?: Transferable[]) => void>()
    const workerScope: {
      onmessage: ((event: MessageEvent<SenderWorkerInput>) => void) | null
      postMessage: typeof postMessage
    } = { onmessage: null, postMessage }
    vi.stubGlobal("self", workerScope)
    await import("../optical/send/worker.js")

    const dispatch = (data: SenderWorkerInput) => workerScope.onmessage?.({ data } as MessageEvent<SenderWorkerInput>)
    dispatch({ type: "init", wasmModule: {}, xxhashWasmModule: {} })
    dispatch({
      type: "prepareBytes",
      name: "payload.bin",
      mediaType: "application/octet-stream",
      data: new ArrayBuffer(3),
    })
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "prepared" })))
    dispatch({ type: "configure", session: 1, frameBytes: 1000, ecc: "L" })
    await vi.waitFor(() => expect(getPart.mock.calls.some(([index]) => index === 1)).toBe(true))

    dispatch({ type: "copyPreparedPart", requestId: 7, part: 2 })

    await vi.waitFor(() => expect(prefetchAborted).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "preparedPart", requestId: 7 }),
        expect.any(Array),
      ),
    )
    expect(getPart.mock.calls.map(([index]) => index)).toEqual([0, 1, 2])
  })

  it("reports codec initialization failure and does not start file preparation", async () => {
    vi.doMock("../optical/shared/nanorq-runtime.js", () => ({
      initializeNanoRQ: () => Promise.reject(new Error("NanoRQ initialization failed")),
    }))
    vi.doMock("../wasm/zstd-runtime.js", () => ({
      initializeZstdEncoder: () => Promise.resolve(),
    }))
    vi.doMock("../wasm/xxhash-runtime.js", () => ({ initializeXXHash: () => Promise.resolve() }))
    const prepareOpticalTransfer = vi.fn()
    vi.doMock("../optical/send/prepared-transfer.js", () => ({ prepareOpticalTransfer }))

    const postMessage = vi.fn<(message: SenderWorkerOutput) => void>()
    const workerScope: {
      onmessage: ((event: MessageEvent<SenderWorkerInput>) => void) | null
      postMessage: typeof postMessage
    } = { onmessage: null, postMessage }
    vi.stubGlobal("self", workerScope)
    await import("../optical/send/worker.js")

    const dispatch = (data: SenderWorkerInput) => workerScope.onmessage?.({ data } as MessageEvent<SenderWorkerInput>)
    dispatch({ type: "init", wasmModule: {}, xxhashWasmModule: {} })
    dispatch({
      type: "prepareBytes",
      name: "payload.bin",
      mediaType: "application/octet-stream",
      data: new ArrayBuffer(1),
    })

    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({ type: "error", message: "NanoRQ initialization failed" }),
    )
    expect(prepareOpticalTransfer).not.toHaveBeenCalled()
  })
})
