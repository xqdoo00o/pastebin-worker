import type {
  CaptureWorkerOutput,
  MediaStreamTrackProcessorConstructor,
  MediaStreamTrackProcessorLike,
} from "../shared/capture.js"
import type { DecodeWorkerPool } from "../shared/worker-pool.js"
import { createCaptureWorker } from "./worker-factory.js"

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number }

const CAPTURE_WORKER_STOP_TIMEOUT_MS = 250

export type CaptureMode = "videoframe-worker" | "videoframe-window" | "readback"

interface CapturePipelineOptions {
  video: HTMLVideoElement
  pool: DecodeWorkerPool
  isDone: () => boolean
  onModeChange: () => void
  forceReadback?: boolean
}

/** Own every camera-frame source and its compatibility fallbacks.
 *
 * A generation invalidates callbacks from the previous source. The decode pool
 * owns accepted frames; this class closes every frame it cannot hand
 * off, so callers only need start(), stop(), and reset(). */
export class CapturePipeline {
  private readonly video: HTMLVideoElement
  private readonly pool: DecodeWorkerPool
  private readonly isDone: () => boolean
  private readonly onModeChange: () => void
  private readonly forceReadback: boolean
  private readonly grab = document.createElement("canvas")
  private grabContext: CanvasRenderingContext2D | null | undefined
  private generation = 0
  private frameId = 0
  private captureWorker: Worker | null = null
  private captureWorkerStartTimer: ReturnType<typeof setTimeout> | undefined
  private videoFrameReader: ReadableStreamDefaultReader<VideoFrame> | null = null
  private videoFrameProcessor: MediaStreamTrackProcessorLike | null = null
  private videoFrameCopyErrorStreak = 0
  private lastVideoFrameCopyErrorAt = -Infinity
  private lastReadbackMediaTime = -Infinity
  private currentMode: CaptureMode

  constructor({ video, pool, isDone, onModeChange, forceReadback = false }: CapturePipelineOptions) {
    this.video = video
    this.pool = pool
    this.isDone = isDone
    this.onModeChange = onModeChange
    this.forceReadback = forceReadback
    this.currentMode = "readback"
  }

  get mode(): CaptureMode {
    return this.currentMode
  }

  start(track: MediaStreamTrack): void {
    const generation = ++this.generation
    this.stopVideoFrameCapture()
    this.startPipeline(track, generation)
  }

  stop(): void {
    this.generation++
    this.stopVideoFrameCapture()
  }

  reset(): void {
    this.stop()
    this.frameId = 0
    this.videoFrameCopyErrorStreak = 0
    this.lastVideoFrameCopyErrorAt = -Infinity
    this.currentMode = "readback"
  }

  restartWorkerSource(track: MediaStreamTrack): void {
    if (this.currentMode !== "videoframe-worker") return
    this.start(track)
  }

  noteVideoFrameCopyError(): void {
    if (!this.currentMode.startsWith("videoframe-") || this.isDone()) return
    const now = performance.now()
    this.videoFrameCopyErrorStreak =
      now - this.lastVideoFrameCopyErrorAt < 2000 ? this.videoFrameCopyErrorStreak + 1 : 1
    this.lastVideoFrameCopyErrorAt = now
    if (this.videoFrameCopyErrorStreak < 3) return

    const generation = ++this.generation
    this.stopVideoFrameCapture()
    this.startCanvasCapture(generation)
  }

  private scheduleFrame(generation: number): void {
    if (this.isDone() || generation !== this.generation) return
    const video = this.video as VideoRVFC
    const nextVideoFrame = () => {
      if (this.isDone() || generation !== this.generation) return
      this.captureFrame()
      this.scheduleFrame(generation)
    }
    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(nextVideoFrame)
      return
    }

    requestAnimationFrame(() => {
      if (this.isDone() || generation !== this.generation) return
      // Animation frames follow the display refresh rate, which can be higher
      // than a MediaStream's frame rate. Avoid reading the same camera image
      // twice when requestVideoFrameCallback is unavailable.
      const mediaTime = video.currentTime
      if (mediaTime !== this.lastReadbackMediaTime) {
        this.lastReadbackMediaTime = mediaTime
        this.captureFrame()
      }
      this.scheduleFrame(generation)
    })
  }

  private submitVideoFrame(message: unknown, frame: VideoFrame): void {
    let taken = false
    try {
      taken = this.pool.submit(message, [frame])
    } finally {
      if (!taken) frame.close()
    }
  }

  private captureVideoFrame(frame: VideoFrame): void {
    if (this.pool.busyCount >= this.pool.size) {
      frame.close()
      return
    }

    const visible = frame.visibleRect ?? {
      x: 0,
      y: 0,
      width: frame.codedWidth,
      height: frame.codedHeight,
    }
    const width = Math.floor(visible.width)
    const height = Math.floor(visible.height)
    if (!width || !height) {
      frame.close()
      return
    }

    this.submitVideoFrame(
      {
        id: this.frameId++,
        frame,
        sx: visible.x,
        sy: visible.y,
        w: width,
        h: height,
      },
      frame,
    )
  }

  private async pumpVideoFrames(reader: ReadableStreamDefaultReader<VideoFrame>, generation: number): Promise<void> {
    try {
      let pendingRead = reader.read()
      for (;;) {
        const next = await pendingRead
        if (next.done) break
        if (this.isDone() || generation !== this.generation) {
          next.value.close()
          break
        }
        this.captureVideoFrame(next.value)
        pendingRead = reader.read()
      }
    } catch {
      // A live media stream can outlast a failed processor; fall back below.
    } finally {
      if (this.videoFrameReader === reader) {
        this.videoFrameReader = null
        this.videoFrameProcessor = null
        if (!this.isDone() && generation === this.generation && this.currentMode === "videoframe-window") {
          this.startCanvasCapture(generation)
        }
      }
    }
  }

  private startCanvasCapture(generation: number): void {
    this.lastReadbackMediaTime = -Infinity
    this.currentMode = "readback"
    this.scheduleFrame(generation)
    this.onModeChange()
  }

  private startWindowOrCanvasCapture(track: MediaStreamTrack, generation: number): void {
    if (this.isDone() || generation !== this.generation) return
    if (!this.forceReadback) {
      const Processor = (
        window as unknown as {
          MediaStreamTrackProcessor?: MediaStreamTrackProcessorConstructor
        }
      ).MediaStreamTrackProcessor
      if (Processor && typeof VideoFrame !== "undefined") {
        try {
          this.videoFrameProcessor = new Processor({ track, maxBufferSize: 1 })
          this.videoFrameReader = this.videoFrameProcessor.readable.getReader()
          this.currentMode = "videoframe-window"
          void this.pumpVideoFrames(this.videoFrameReader, generation)
          this.onModeChange()
          return
        } catch {
          this.videoFrameReader = null
          this.videoFrameProcessor = null
        }
      }
    }

    this.startCanvasCapture(generation)
  }

  private startWorkerCapture(track: MediaStreamTrack, generation: number): boolean {
    let worker: Worker
    try {
      worker = createCaptureWorker()
    } catch {
      return false
    }

    this.captureWorker = worker
    let ready = false
    const fail = () => {
      if (this.captureWorker !== worker) return
      clearTimeout(this.captureWorkerStartTimer)
      this.captureWorkerStartTimer = undefined
      this.captureWorker = null
      worker.terminate()
      if (!this.isDone() && generation === this.generation) {
        this.startWindowOrCanvasCapture(track, generation)
      }
    }

    worker.onmessage = (event: MessageEvent<CaptureWorkerOutput>) => {
      const message = event.data
      if (this.captureWorker !== worker || this.isDone() || generation !== this.generation) {
        if (message.type === "frame") message.frame.close()
        return
      }

      if (message.type === "support") {
        if (!message.supported) {
          fail()
          return
        }
        let workerTrack: MediaStreamTrack | null = null
        try {
          workerTrack = track.clone()
          worker.postMessage({ type: "start", track: workerTrack }, [workerTrack])
          workerTrack = null
        } catch {
          workerTrack?.stop()
          fail()
        }
        return
      }

      if (message.type === "ready") {
        ready = true
        clearTimeout(this.captureWorkerStartTimer)
        this.captureWorkerStartTimer = undefined
        this.currentMode = "videoframe-worker"
        this.onModeChange()
        return
      }

      if (message.type === "error" || message.type === "stopped" || !ready) {
        if (message.type === "frame") message.frame.close()
        fail()
        return
      }

      try {
        this.captureVideoFrame(message.frame)
      } catch {
        fail()
        return
      }
      if (this.captureWorker === worker && !this.isDone() && generation === this.generation) {
        try {
          worker.postMessage({ type: "next" })
        } catch {
          fail()
        }
      }
    }
    worker.onerror = fail
    worker.onmessageerror = fail
    this.captureWorkerStartTimer = setTimeout(fail, 2000)
    try {
      worker.postMessage({ type: "probe" })
    } catch {
      clearTimeout(this.captureWorkerStartTimer)
      this.captureWorkerStartTimer = undefined
      if (this.captureWorker === worker) this.captureWorker = null
      worker.terminate()
      return false
    }
    return true
  }

  private startPipeline(track: MediaStreamTrack, generation: number): void {
    if (!this.forceReadback && this.startWorkerCapture(track, generation)) {
      return
    }
    this.startWindowOrCanvasCapture(track, generation)
  }

  private retireCaptureWorker(worker: Worker): void {
    let retired = false
    const finish = () => {
      if (retired) return
      retired = true
      clearTimeout(timeout)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    worker.onmessage = (event: MessageEvent<CaptureWorkerOutput>) => {
      const message = event.data
      if (message.type === "frame") message.frame.close()
      else if (message.type === "stopped") finish()
    }
    worker.onerror = finish
    worker.onmessageerror = finish
    const timeout = setTimeout(finish, CAPTURE_WORKER_STOP_TIMEOUT_MS)
    try {
      worker.postMessage({ type: "stop" })
    } catch {
      finish()
    }
  }

  private stopVideoFrameCapture(): void {
    clearTimeout(this.captureWorkerStartTimer)
    this.captureWorkerStartTimer = undefined
    const worker = this.captureWorker
    this.captureWorker = null
    if (worker) this.retireCaptureWorker(worker)
    const reader = this.videoFrameReader
    this.videoFrameReader = null
    this.videoFrameProcessor = null
    if (reader) void reader.cancel().catch(() => undefined)
  }

  private captureFrame(): void {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (!width || !height) return

    if (this.pool.busyCount >= this.pool.size) return

    if (this.grab.width !== width || this.grab.height !== height) {
      this.grab.width = width
      this.grab.height = height
    }
    if (this.grabContext === undefined) {
      this.grabContext = this.grab.getContext("2d", { willReadFrequently: true, alpha: false })
    }
    const context = this.grabContext
    if (!context) return
    context.drawImage(this.video, 0, 0)
    const image = context.getImageData(0, 0, width, height)
    this.pool.submit({ id: this.frameId++, buf: image.data.buffer, w: width, h: height }, [image.data.buffer])
  }
}
