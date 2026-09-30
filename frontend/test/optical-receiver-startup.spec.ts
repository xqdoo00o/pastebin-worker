import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createOpticalReceiverController,
  type OpticalReceiverController,
} from "../optical/receive/receiver-controller.js"
import { FountainWorkerClient } from "../optical/receive/fountain-client.js"
import { DecodeWorkerPool } from "../optical/shared/worker-pool.js"
import { CapturePipeline } from "../optical/receive/capture-pipeline.js"

const codecs = vi.hoisted(() => ({ optical: vi.fn<() => Promise<WebAssembly.Module>>() }))
vi.mock("../optical/codec/wasm-module.js", () => ({ loadOpticalCodecModule: codecs.optical }))
vi.mock("../optical/shared/wasm-module.js", () => ({ loadNanoRQCodecModule: () => Promise.resolve({}) }))
vi.mock("../wasm/zstd-loader.js", () => ({ ensureZstdDecoderReady: () => Promise.resolve() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function capturedStream(capabilities: MediaTrackCapabilities = {}) {
  const track = {
    stop: vi.fn(),
    getCapabilities: () => capabilities,
    applyConstraints: vi.fn<MediaStreamTrack["applyConstraints"]>().mockResolvedValue(undefined),
    getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
  return { stream, track }
}

const controllers: OpticalReceiverController[] = []
const ensureWorker = vi.fn<FountainWorkerClient["ensure"]>()
const startCapture = vi.fn<CapturePipeline["start"]>()
const media = {
  getUserMedia: vi.fn<() => Promise<MediaStream>>(),
  getDisplayMedia: vi.fn<() => Promise<MediaStream>>(),
  enumerateDevices: () => Promise.resolve([]),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}

function controller() {
  const video = document.createElement("video")
  Object.defineProperties(video, {
    readyState: { value: 2 },
    videoWidth: { value: 1280 },
    videoHeight: { value: 720 },
  })
  const instance = createOpticalReceiverController(
    {
      video,
      preview: document.createElement("div"),
      cameraBox: document.createElement("div"),
      progressBar: document.createElement("div"),
    },
    () => undefined,
  )
  controllers.push(instance)
  return { instance, video }
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  vi.stubGlobal("navigator", { mediaDevices: media, hardwareConcurrency: 4, userAgent: "Desktop" })
  codecs.optical.mockReset().mockResolvedValue({})
  media.getUserMedia.mockReset()
  media.getDisplayMedia.mockReset()
  vi.spyOn(DecodeWorkerPool.prototype, "resize").mockImplementation(() => undefined)
  startCapture.mockReset()
  ensureWorker.mockReset().mockResolvedValue({} as Worker)
  vi.spyOn(CapturePipeline.prototype, "start").mockImplementation(startCapture)
  vi.spyOn(FountainWorkerClient.prototype, "ensure").mockImplementation(ensureWorker)
})

afterEach(async () => {
  for (const instance of controllers.splice(0)) instance.dispose()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("receiver startup ownership", () => {
  it("switches cameras while retaining the initialized fountain worker", async () => {
    const first = capturedStream()
    const next = capturedStream()
    media.getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(next.stream)
    const { instance, video } = controller()
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    instance.updateCamera("next-lens")
    await vi.advanceTimersByTimeAsync(0)
    expect(first.track.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBe(next.stream)
    expect(startCapture).toHaveBeenLastCalledWith(next.track)
    expect(ensureWorker).toHaveBeenCalledOnce()
  })

  it("releases a switched camera acquired after entering screen mode", async () => {
    const first = capturedStream()
    const next = capturedStream()
    const screen = capturedStream()
    const acquisition = deferred<MediaStream>()
    media.getUserMedia.mockResolvedValueOnce(first.stream).mockReturnValueOnce(acquisition.promise)
    media.getDisplayMedia.mockResolvedValue(screen.stream)
    const { instance, video } = controller()
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    instance.updateCamera("next-lens")
    instance.switchMode("screen")
    await vi.advanceTimersByTimeAsync(0)
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    acquisition.resolve(next.stream)
    await vi.advanceTimersByTimeAsync(0)
    expect(next.track.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBe(screen.stream)
    expect(screen.track.stop).not.toHaveBeenCalled()
  })

  it("does not replace a screen preview when an old camera exposure change finishes", async () => {
    const first = capturedStream()
    const next = capturedStream({
      exposureMode: ["manual"],
      iso: { min: 100, max: 2000, step: 100 },
    } as MediaTrackCapabilities)
    const exposure = deferred<void>()
    next.track.applyConstraints.mockReturnValue(exposure.promise)
    const screen = capturedStream()
    media.getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(next.stream)
    media.getDisplayMedia.mockResolvedValue(screen.stream)
    const { instance, video } = controller()
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    instance.updateCamera("next-lens")
    await vi.advanceTimersByTimeAsync(0)
    expect(next.track.applyConstraints).toHaveBeenCalledOnce()
    instance.switchMode("screen")
    await vi.advanceTimersByTimeAsync(0)
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    exposure.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(video.srcObject).toBe(screen.stream)
    expect(startCapture).toHaveBeenLastCalledWith(screen.track)
    expect(screen.track.stop).not.toHaveBeenCalled()
  })

  it("stops a camera acquired after disposal without initializing its worker", async () => {
    const acquisition = deferred<MediaStream>()
    media.getUserMedia.mockReturnValue(acquisition.promise)
    const { instance, video } = controller()
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(media.getUserMedia).toHaveBeenCalledOnce()
    instance.dispose()
    const captured = capturedStream()
    acquisition.resolve(captured.stream)
    await vi.advanceTimersByTimeAsync(0)
    expect(captured.track.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).not.toBe(captured.stream)
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it("requests screen capture before awaiting codec loading", async () => {
    const loading = deferred<WebAssembly.Module>()
    codecs.optical.mockReturnValue(loading.promise)
    const captured = capturedStream()
    media.getDisplayMedia.mockResolvedValue(captured.stream)
    const { instance } = controller()
    instance.switchMode("screen")
    await vi.advanceTimersByTimeAsync(0)
    instance.start()
    expect(media.getDisplayMedia).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(ensureWorker).not.toHaveBeenCalled()
    loading.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(startCapture).toHaveBeenCalledWith(captured.track)
  })

  it("does not tear down a new screen session when an old camera handshake rejects", async () => {
    const handshake = deferred<Worker>()
    ensureWorker.mockReturnValueOnce(handshake.promise)
    const camera = capturedStream()
    const screen = capturedStream()
    media.getUserMedia.mockResolvedValue(camera.stream)
    media.getDisplayMedia.mockResolvedValue(screen.stream)
    const { instance, video } = controller()
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(ensureWorker).toHaveBeenCalledOnce()
    instance.switchMode("screen")
    await vi.advanceTimersByTimeAsync(0)
    instance.start()
    await vi.advanceTimersByTimeAsync(0)
    handshake.reject(new DOMException("Cancelled", "AbortError"))
    await vi.advanceTimersByTimeAsync(0)
    expect(video.srcObject).toBe(screen.stream)
    expect(screen.track.stop).not.toHaveBeenCalled()
    expect(startCapture).toHaveBeenCalledExactlyOnceWith(screen.track)
  })
})
