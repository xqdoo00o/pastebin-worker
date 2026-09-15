import { afterEach, describe, expect, it, vi } from "vitest"
import { CapturePipeline } from "../optical/receive/capture-pipeline.js"
import {
  acquireCamera,
  cameraOptionState,
  cameraSelection,
  formatActiveReceiverSettings,
  formatPendingReceiverSettings,
  formatReceiverStatus,
} from "../optical/receive/camera.js"
import { tightVideoFrameLayout } from "../optical/shared/capture.js"
import { DecodeWorkerPool, type PoolWorker } from "../optical/shared/worker-pool.js"
import { opticalDecodeWorkerLimit, opticalDefaultDecodeWorkerCount } from "../optical/receive/receiver-controller.js"
import { prepareMediaPreview } from "../optical/receive/media-source.js"

const originalVideoFrame = globalThis.VideoFrame
const originalWorker = globalThis.Worker
const originalProcessor = (window as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")

afterEach(() => {
  Object.defineProperty(globalThis, "VideoFrame", { configurable: true, value: originalVideoFrame })
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker })
  Object.defineProperty(window, "MediaStreamTrackProcessor", { configurable: true, value: originalProcessor })
  if (originalRequestAnimationFrame)
    Object.defineProperty(globalThis, "requestAnimationFrame", originalRequestAnimationFrame)
  else Reflect.deleteProperty(globalThis, "requestAnimationFrame")
  vi.restoreAllMocks()
})

describe("optical camera selection", () => {
  it("prefers the rear camera in auto mode and pins an explicitly selected lens", () => {
    expect(cameraSelection("")).toEqual({ facingMode: "environment" })
    expect(cameraSelection("wide-angle-id")).toEqual({ deviceId: { exact: "wide-angle-id" } })
  })

  it("lists labeled video inputs after permission and preserves the selected lens", () => {
    const state = cameraOptionState(
      [
        { kind: "audioinput", deviceId: "mic", label: "Microphone" },
        { kind: "videoinput", deviceId: "wide", label: "Back Wide Camera" },
        { kind: "videoinput", deviceId: "tele", label: "" },
      ],
      "tele",
    )

    expect(state).toEqual({
      options: [
        { value: "", label: "Auto (rear camera)" },
        { value: "wide", label: "Back Wide Camera" },
        { value: "tele", label: "Camera 2" },
      ],
      selected: "tele",
      disabled: false,
    })
  })

  it("keeps the picker auto-only when the device has no real choice", () => {
    expect(cameraOptionState([{ kind: "videoinput", deviceId: "only", label: "Only Camera" }], "only")).toEqual({
      options: [{ value: "", label: "Auto (rear camera)" }],
      selected: "",
      disabled: true,
    })
  })

  it("requests ideal frame rate on the first and only camera acquisition", async () => {
    const stream = {} as MediaStream
    const getUserMedia = vi
      .fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockResolvedValue(stream)

    await expect(acquireCamera(getUserMedia, cameraSelection("wide"), 1920, 60)).resolves.toBe(stream)
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        deviceId: { exact: "wide" },
        width: 1920,
        height: 1440,
        frameRate: { ideal: 60 },
      },
    })
  })
})

describe("optical camera frame layout", () => {
  it("computes exact packed plane storage and reuses layout entries", () => {
    const first = tightVideoFrameLayout("I420A", 4, 2)
    const firstPlane = first.layout[0]

    expect(first.byteLength).toBe(20)
    expect(first.layout).toEqual([
      { offset: 0, stride: 4 },
      { offset: 8, stride: 2 },
      { offset: 10, stride: 2 },
      { offset: 12, stride: 4 },
    ])

    const reused = tightVideoFrameLayout("NV12", 4, 2, first)
    expect(reused).toBe(first)
    expect(reused.layout[0]).toBe(firstPlane)
    expect(reused.byteLength).toBe(12)
    expect(reused.layout).toEqual([
      { offset: 0, stride: 4 },
      { offset: 8, stride: 4 },
    ])
  })
})

class MockCaptureSourceWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn()
  readonly terminate = vi.fn()

  constructor(instances: MockCaptureSourceWorker[]) {
    instances.push(this)
  }

  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

function installCaptureSourceWorker(): MockCaptureSourceWorker[] {
  const instances: MockCaptureSourceWorker[] = []
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: class extends MockCaptureSourceWorker {
      constructor() {
        super(instances)
      }
    },
  })
  return instances
}

describe("CapturePipeline", () => {
  it("falls back after repeated VideoFrame copy failures and invalidates scheduled captures on stop", () => {
    const callbacks: (() => void)[] = []
    const video = document.createElement("video")
    Object.defineProperty(video, "requestVideoFrameCallback", {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        callbacks.push(callback)
        return callbacks.length
      }),
    })

    const reader = {
      read: vi.fn(() => new Promise<ReadableStreamReadResult<VideoFrame>>(() => undefined)),
      cancel: vi.fn(() => Promise.resolve()),
    }
    class MockProcessor {
      readonly readable = { getReader: () => reader }
    }
    Object.defineProperty(globalThis, "VideoFrame", { configurable: true, value: class {} })
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
    Object.defineProperty(window, "MediaStreamTrackProcessor", { configurable: true, value: MockProcessor })

    const pool = new DecodeWorkerPool(() => {
      throw new Error("decode workers are not needed for this lifecycle test")
    })
    const onModeChange = vi.fn()
    const pipeline = new CapturePipeline({
      video,
      pool,
      isDone: () => false,
      onModeChange,
    })

    pipeline.start({} as MediaStreamTrack)
    expect(pipeline.mode).toBe("videoframe-window")

    pipeline.noteVideoFrameCopyError()
    pipeline.noteVideoFrameCopyError()
    pipeline.noteVideoFrameCopyError()
    expect(pipeline.mode).toBe("readback")
    expect(reader.cancel).toHaveBeenCalledOnce()
    expect(callbacks).toHaveLength(1)

    pipeline.stop()
    callbacks[0]()
    expect(callbacks).toHaveLength(1)
    expect(onModeChange).toHaveBeenCalledTimes(2)
  })

  it("does not read the same video frame twice in the animation-frame fallback", () => {
    const callbacks: FrameRequestCallback[] = []
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return callbacks.length
      }),
    })

    const video = document.createElement("video")
    let mediaTime = 1
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 4 },
      videoHeight: { configurable: true, value: 4 },
      currentTime: { configurable: true, get: () => mediaTime },
    })
    const drawImage = vi.fn()
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(4 * 4 * 4) }))
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      getImageData,
    } as unknown as CanvasRenderingContext2D)

    const submit = vi.fn(() => true)
    const pool = {
      busyCount: 0,
      size: 1,
      submit,
    } as unknown as DecodeWorkerPool
    const pipeline = new CapturePipeline({
      video,
      pool,
      isDone: () => false,
      onModeChange: vi.fn(),
      forceReadback: true,
    })

    pipeline.start({} as MediaStreamTrack)
    callbacks.shift()!(0)
    expect(submit).toHaveBeenCalledOnce()

    callbacks.shift()!(16)
    expect(submit).toHaveBeenCalledOnce()

    mediaTime = 1.033
    callbacks.shift()!(32)
    expect(submit).toHaveBeenCalledTimes(2)

    pipeline.stop()
    callbacks.shift()!(48)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(drawImage).toHaveBeenCalledTimes(2)
    expect(getImageData).toHaveBeenCalledTimes(2)
  })

  it("stops the worker-owned camera track before terminating its capture worker", () => {
    const workers = installCaptureSourceWorker()
    const clonedTrack = { stop: vi.fn() } as unknown as MediaStreamTrack
    const cloneTrack = vi.fn(() => clonedTrack)
    const track = { clone: cloneTrack } as unknown as MediaStreamTrack
    const pool = { busyCount: 0, size: 1, submit: vi.fn(() => true) } as unknown as DecodeWorkerPool
    const pipeline = new CapturePipeline({
      video: document.createElement("video"),
      pool,
      isDone: () => false,
      onModeChange: vi.fn(),
    })

    pipeline.start(track)
    const worker = workers[0]
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "probe" })
    worker.reply({ type: "support", supported: true })
    expect(cloneTrack).toHaveBeenCalledOnce()
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "start", track: clonedTrack }, [clonedTrack])
    worker.reply({ type: "ready" })

    pipeline.stop()
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "stop" })
    expect(worker.terminate).not.toHaveBeenCalled()

    worker.reply({ type: "stopped" })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it("force-terminates an unresponsive capture worker after the stop timeout", async () => {
    vi.useFakeTimers()
    try {
      const workers = installCaptureSourceWorker()
      const pool = { busyCount: 0, size: 1, submit: vi.fn(() => true) } as unknown as DecodeWorkerPool
      const pipeline = new CapturePipeline({
        video: document.createElement("video"),
        pool,
        isDone: () => false,
        onModeChange: vi.fn(),
      })

      pipeline.start({} as MediaStreamTrack)
      const worker = workers[0]
      pipeline.stop()
      expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "stop" })
      expect(worker.terminate).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(250)
      expect(worker.terminate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("media preview startup", () => {
  it("accepts a Safari display-capture frame while play() remains pending", async () => {
    const video = document.createElement("video")
    const stream = {} as MediaStream
    const play = vi.spyOn(video, "play").mockReturnValue(new Promise(() => undefined))
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 0 },
      videoWidth: { configurable: true, value: 0 },
      videoHeight: { configurable: true, value: 0 },
    })

    const preview = prepareMediaPreview(video, stream, 1_000)
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    })
    video.dispatchEvent(new Event("loadeddata"))

    await expect(preview).resolves.toBe(true)
    expect(play).toHaveBeenCalledOnce()
  })

  it("times out instead of remaining in the starting phase", async () => {
    vi.useFakeTimers()
    try {
      const video = document.createElement("video")
      const stream = {} as MediaStream
      vi.spyOn(video, "play").mockReturnValue(new Promise(() => undefined))
      Object.defineProperties(video, {
        readyState: { configurable: true, value: 0 },
        videoWidth: { configurable: true, value: 0 },
        videoHeight: { configurable: true, value: 0 },
      })

      const preview = prepareMediaPreview(video, stream, 5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(preview).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("optical receiver status", () => {
  const camera = { width: 1280, height: 720, frameRate: 29.7 }
  const requested = { width: 1920, frameRate: 60 }

  it("switches from searching to receiving while keeping live camera details", () => {
    expect(formatReceiverStatus("searching", camera)).toBe("Searching for a QR stream · 1280×720 @ 30 fps")
    expect(formatReceiverStatus("receiving", camera)).toBe("Receiving QR stream · 1280×720 @ 30 fps")
  })

  it("distinguishes requested settings from the camera's negotiated settings", () => {
    expect(formatPendingReceiverSettings(requested, 3)).toBe("Will request 1920 px wide @ 60 fps · 3 decode workers")
    expect(formatActiveReceiverSettings(camera, requested, 3, "readback")).toBe(
      "Actual 1280×720 @ 30 fps · requested 1920 px wide @ 60 fps · 3 decode workers · " +
        "readback capture · changes apply live",
    )
  })
})

class MockPoolWorker implements PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn()
  readonly dispose = vi.fn()
  readonly terminate = vi.fn()

  reply(id: number, forwardedSymbols = 0): void {
    this.onmessage?.({
      data: {
        id,
        forwardedSymbols,
      },
    } as MessageEvent)
  }

  rejectInitialization(message: string): void {
    this.onmessage?.({
      data: {
        id: -1,
        forwardedSymbols: 0,
        error: message,
      },
    } as MessageEvent)
  }

  fail(message = "worker failed"): void {
    this.onerror?.({ error: new Error(message), message } as ErrorEvent)
  }
}

describe("optical decode worker limit", () => {
  it.each([
    [16, 16],
    [8, 8],
    [4, 4],
    [2, 2],
    [1, 1],
    [0, 6],
  ])("allows one worker per %s logical processors, up to %s decode workers", (hardwareConcurrency, expected) => {
    expect(opticalDecodeWorkerLimit(hardwareConcurrency)).toBe(expected)
  })

  it.each([
    [16, 14],
    [8, 6],
    [4, 2],
    [2, 1],
    [1, 1],
  ])("defaults to %s minus two logical processors, clamped to %s worker(s)", (workerLimit, expected) => {
    expect(opticalDefaultDecodeWorkerCount(workerLimit)).toBe(expected)
  })
})

describe("DecodeWorkerPool", () => {
  it("reports a synchronous worker construction failure instead of throwing from resize", () => {
    const fatal = vi.fn()
    const pool = new DecodeWorkerPool(
      () => {
        throw new Error("Worker construction is blocked")
      },
      undefined,
      fatal,
    )

    expect(() => pool.resize(2)).not.toThrow()
    expect(pool.size).toBe(0)
    expect(fatal).toHaveBeenCalledOnce()
    expect(fatal.mock.calls[0][0]).toMatchObject({ message: "Worker construction is blocked" })
  })

  it("replaces a worker whose WASM initialization fails", () => {
    const workers: MockPoolWorker[] = []
    const fatal = vi.fn()
    const pool = new DecodeWorkerPool(
      () => {
        const worker = new MockPoolWorker()
        workers.push(worker)
        return worker
      },
      undefined,
      fatal,
    )

    pool.resize(1)
    workers[0].rejectInitialization("optical WASM could not instantiate")

    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(pool.size).toBe(1)
    expect(workers).toHaveLength(2)
    expect(fatal).not.toHaveBeenCalled()
    workers[1].reply(-1)
    pool.resize(0)
  })

  it("releases a busy slot, resolves idle waiters, and replaces a failed worker in place", async () => {
    const workers: MockPoolWorker[] = []
    const fatal = vi.fn()
    const completed = vi.fn()
    const taskFailed = vi.fn()
    const pool = new DecodeWorkerPool(
      () => {
        const worker = new MockPoolWorker()
        workers.push(worker)
        return worker
      },
      undefined,
      fatal,
      completed,
      taskFailed,
    )

    pool.resize(2)
    expect(pool.submit({ id: 1 }, [])).toBe(true)
    expect(pool.busyCount).toBe(1)

    workers[0].fail()

    expect(workers[0].dispose).toHaveBeenCalledOnce()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(taskFailed).toHaveBeenCalledOnce()
    expect(pool.size).toBe(2)
    expect(pool.busyCount).toBe(0)
    expect(fatal).not.toHaveBeenCalled()

    expect(pool.submit({ id: 2 }, [])).toBe(true)
    expect(workers[2].postMessage).toHaveBeenCalledWith({ id: 2 }, [])
    let becameIdle = false
    const idle = pool.whenIdle().then(() => {
      becameIdle = true
    })
    await Promise.resolve()
    expect(becameIdle).toBe(false)
    workers[2].reply(2, 1)
    await idle
    expect(becameIdle).toBe(true)
    expect(completed).toHaveBeenCalledWith({
      id: 2,
      forwardedSymbols: 1,
    })
    expect(pool.busyCount).toBe(0)

    pool.resize(0)
    expect(workers[1].dispose).toHaveBeenCalledOnce()
    expect(workers[2].dispose).toHaveBeenCalledOnce()
  })

  it("stops the pool and reports repeated failures before any frame succeeds", () => {
    const workers: MockPoolWorker[] = []
    const fatal = vi.fn()
    const pool = new DecodeWorkerPool(
      () => {
        const worker = new MockPoolWorker()
        workers.push(worker)
        return worker
      },
      undefined,
      fatal,
    )

    pool.resize(1)
    workers[0].fail("first")
    workers[1].fail("second")
    workers[2].fail("third")

    expect(pool.size).toBe(0)
    expect(pool.busyCount).toBe(0)
    expect(workers.every((worker) => worker.dispose.mock.calls.length === 1)).toBe(true)
    expect(fatal).toHaveBeenCalledOnce()
    expect(fatal.mock.calls[0][0]).toMatchObject({ message: "third" })
  })
})
