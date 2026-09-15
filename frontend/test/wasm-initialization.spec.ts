import { afterEach, describe, expect, it, vi } from "vitest"
import { compileWasmModule, createRetryableLoader, supportsWasmSimd } from "../utils/wasm.js"
import type { ArchiveWorkerRequest, ArchiveWorkerResponse } from "../utils/archiveCore.js"
import type * as WasmUtils from "../utils/wasm.js"

const EMPTY_WASM = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)

afterEach(() => {
  vi.doUnmock("../utils/wasm.js")
  vi.doUnmock("../wasm/zstd/zstd_encoder.js")
  vi.doUnmock("../wasm/zstd-loader.js")
  vi.doUnmock("../optical/nanorq-codec/nanorq_codec.js")
  vi.doUnmock("../wasm/zstd-runtime.js")
  vi.doUnmock("../utils/archiveCore.js")
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe("shared WASM loader", () => {
  it("caches the SIMD capability check, including a false result", () => {
    const validate = vi.spyOn(WebAssembly, "validate").mockReturnValue(false)

    expect(supportsWasmSimd()).toBe(false)
    expect(supportsWasmSimd()).toBe(false)
    expect(validate).toHaveBeenCalledOnce()
  })

  it("stream-compiles hosted assets", async () => {
    const compiled = new WebAssembly.Module(EMPTY_WASM)
    const compileStreaming = vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(compiled)
    const compile = vi.spyOn(WebAssembly, "compile")
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(EMPTY_WASM, { headers: { "content-type": "application/wasm" } }))),
    )

    await expect(compileWasmModule("https://example.test/codec.wasm", "test codec")).resolves.toBe(compiled)
    expect(compileStreaming).toHaveBeenCalledOnce()
    expect(compile).not.toHaveBeenCalled()
  })

  it("buffers inlined standalone assets", async () => {
    const compiled = new WebAssembly.Module(EMPTY_WASM)
    const compileStreaming = vi.spyOn(WebAssembly, "compileStreaming")
    const compile = vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiled)
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(EMPTY_WASM, { headers: { "content-type": "application/wasm" } }))),
    )

    await expect(compileWasmModule("data:application/wasm;base64,AGFzbQEAAAA=", "test codec")).resolves.toBe(compiled)
    expect(compileStreaming).not.toHaveBeenCalled()
    expect(compile).toHaveBeenCalledOnce()
  })

  it("adds codec context to download and compilation failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network offline"))),
    )
    await expect(compileWasmModule("https://example.test/codec.wasm", "test codec")).rejects.toThrow(
      "test codec: WASM download failed: network offline",
    )

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(Uint8Array.of(1, 2, 3)))),
    )
    await expect(compileWasmModule("data:application/wasm;base64,AQID", "test codec")).rejects.toThrow(
      /test codec: WASM compilation failed/,
    )
  })

  it("shares an in-flight load but clears a rejected attempt for retry", async () => {
    const load = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(42)
    const retryable = createRetryableLoader(load)

    const first = retryable()
    expect(retryable()).toBe(first)
    await expect(first).rejects.toThrow("temporary failure")
    await expect(retryable()).resolves.toBe(42)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("uses the threaded zstd encoder only at the benchmarked large-input threshold", async () => {
    const module = new WebAssembly.Module(EMPTY_WASM)
    const compileWasmModule = vi.fn().mockResolvedValue(module)
    vi.doMock("../utils/wasm.js", async (importOriginal) => ({
      ...(await importOriginal<typeof WasmUtils>()),
      compileWasmModule,
      selectWasmSimd: () => true,
      supportsWasmThreads: () => true,
    }))

    const { loadZstdEncoderWasmModule, ZSTD_THREADED_MIN_INPUT_BYTES } = await import("../wasm/zstd-loader.js")
    await loadZstdEncoderWasmModule(ZSTD_THREADED_MIN_INPUT_BYTES - 1)
    await loadZstdEncoderWasmModule(ZSTD_THREADED_MIN_INPUT_BYTES)

    expect(compileWasmModule).toHaveBeenCalledTimes(2)
    expect(compileWasmModule.mock.calls[0][0]).toContain("zstd_encoder_simd.wasm")
    expect(compileWasmModule.mock.calls[1][0]).toContain("zstd_encoder_threaded.wasm")
  })
})

describe("WASM runtime initialization", () => {
  it("allows zstd initialization to retry after instantiation fails", async () => {
    const factory = vi.fn().mockRejectedValueOnce(new Error("zstd instantiation failed")).mockResolvedValueOnce({})
    vi.doMock("../wasm/zstd/zstd_encoder.js", () => ({ default: factory }))
    const { initializeZstdEncoder } = await import("../wasm/zstd-runtime.js")
    const module = new WebAssembly.Module(EMPTY_WASM)

    await expect(initializeZstdEncoder(module)).rejects.toThrow("zstd instantiation failed")
    await expect(initializeZstdEncoder(module)).resolves.toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it("allows NanoRQ initialization to retry after instantiation fails", async () => {
    const initialized = {}
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("NanoRQ instantiation failed"))
      .mockResolvedValueOnce(initialized)
    vi.doMock("../optical/nanorq-codec/nanorq_codec.js", () => ({ default: factory }))
    const { initializeNanoRQ } = await import("../optical/shared/nanorq-runtime.js")
    const module = new WebAssembly.Module(EMPTY_WASM)

    await expect(initializeNanoRQ(module)).rejects.toThrow("NanoRQ instantiation failed")
    await expect(initializeNanoRQ(module)).resolves.toBe(initialized)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})

describe("worker initialization", () => {
  it("makes the archive worker await and report zstd initialization failure", async () => {
    const streamZipFiles = vi.fn()
    vi.doMock("../utils/archiveCore.js", () => ({ streamZipFiles }))
    vi.doMock("../wasm/zstd-runtime.js", () => ({
      initializeZstdEncoder: () => Promise.reject(new Error("zstd worker initialization failed")),
    }))

    const postMessage = vi.fn<(message: ArchiveWorkerResponse) => void>()
    const workerScope: {
      onmessage: ((event: MessageEvent<ArchiveWorkerRequest>) => void) | null
      postMessage: typeof postMessage
    } = { onmessage: null, postMessage }
    vi.stubGlobal("self", workerScope)
    await import("../utils/archive.worker.js")

    const dispatch = (data: ArchiveWorkerRequest) =>
      workerScope.onmessage?.({ data } as MessageEvent<ArchiveWorkerRequest>)
    dispatch({ type: "init", zstdEncoderWasmModule: {} })
    dispatch({ type: "start", files: [], compression: "zstd", useFflateWorker: false })

    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        type: "error",
        error: { name: "Error", message: "zstd worker initialization failed" },
      }),
    )
    expect(streamZipFiles).not.toHaveBeenCalled()
  })
})
