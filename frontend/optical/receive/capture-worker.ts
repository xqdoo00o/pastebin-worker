// Camera frame source for engines that expose MediaStreamTrackProcessor only
// in DedicatedWorkerGlobalScope (notably Safari). The receiver acknowledges
// each delivered frame before another read, so at most one VideoFrame waits in
// the main-thread message queue; maxBufferSize: 1 keeps the newest camera frame.

import type {
  CaptureWorkerInput,
  CaptureWorkerOutput,
  MediaStreamTrackProcessorConstructor,
} from "../shared/capture.js"
import { errorMessage } from "../../utils/errors.js"

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<CaptureWorkerInput>) => void) | null
  postMessage(message: CaptureWorkerOutput, transfer?: Transferable[]): void
  MediaStreamTrackProcessor?: MediaStreamTrackProcessorConstructor
}

let reader: ReadableStreamDefaultReader<VideoFrame> | null = null
let ownedTrack: MediaStreamTrack | null = null
let awaitingNext = false
let reading = false
let stopped = false
let stopPromise: Promise<void> | undefined

function supported(): boolean {
  return typeof ctx.MediaStreamTrackProcessor === "function" && typeof VideoFrame !== "undefined"
}

function releaseCapture(): Promise<void> {
  stopped = true
  awaitingNext = false
  const currentReader = reader
  reader = null
  ownedTrack?.stop()
  ownedTrack = null
  if (!currentReader) return Promise.resolve()
  try {
    return currentReader.cancel().catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

function fail(error: unknown): void {
  if (stopped) return
  void releaseCapture()
  ctx.postMessage({ type: "error", message: errorMessage(error) })
}

async function readNext(): Promise<void> {
  if (stopped || reading || awaitingNext || !reader) return
  reading = true
  try {
    const next = await reader.read()
    if (next.done) {
      fail(new Error("camera frame stream ended"))
      return
    }
    awaitingNext = true
    try {
      ctx.postMessage({ type: "frame", frame: next.value }, [next.value])
    } catch (error) {
      next.value.close()
      throw error
    }
  } catch (error) {
    fail(error)
  } finally {
    reading = false
  }
}

ctx.onmessage = (event) => {
  const message = event.data
  if (message.type === "probe") {
    ctx.postMessage({ type: "support", supported: supported() })
    return
  }

  if (message.type === "start") {
    if (!supported()) {
      message.track.stop()
      fail(new Error("MediaStreamTrackProcessor is unavailable in this worker"))
      return
    }
    try {
      ownedTrack = message.track
      stopPromise = undefined
      const Processor = ctx.MediaStreamTrackProcessor!
      const processor = new Processor({
        track: ownedTrack,
        maxBufferSize: 1,
      })
      reader = processor.readable.getReader()
      stopped = false
      ctx.postMessage({ type: "ready" })
      void readNext()
    } catch (error) {
      fail(error)
    }
    return
  }

  if (message.type === "next") {
    awaitingNext = false
    void readNext()
    return
  }

  stopPromise ??= releaseCapture().then(() => {
    ctx.postMessage({ type: "stopped" })
  })
}
