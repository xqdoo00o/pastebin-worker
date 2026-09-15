export type MediaPreviewResult = "ready" | "stale" | "no-frame"

const HAVE_CURRENT_VIDEO_DATA = 2
const MEDIA_PREVIEW_TIMEOUT_MS = 5_000

function previewHasFrame(video: HTMLVideoElement, stream: MediaStream): boolean {
  return (
    video.srcObject === stream &&
    video.readyState >= HAVE_CURRENT_VIDEO_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

/** Start playback and wait for usable intrinsic dimensions as one bounded
 * operation. WebKit can leave play() pending for an active display-capture
 * stream, even though loadeddata/resize subsequently proves a frame exists. */
export function prepareMediaPreview(
  video: HTMLVideoElement,
  stream: MediaStream,
  timeoutMs = MEDIA_PREVIEW_TIMEOUT_MS,
): Promise<boolean> {
  video.srcObject = stream
  if (previewHasFrame(video, stream)) return Promise.resolve(true)

  return new Promise((resolve) => {
    let settled = false
    const events: (keyof HTMLMediaElementEventMap)[] = ["loadeddata", "loadedmetadata", "canplay", "resize"]
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      for (const event of events) video.removeEventListener(event, check)
      video.removeEventListener("error", failed)
      resolve(ready)
    }
    const check = () => {
      if (previewHasFrame(video, stream)) finish(true)
    }
    const failed = () => finish(false)
    const timeout = window.setTimeout(() => finish(previewHasFrame(video, stream)), timeoutMs)
    for (const event of events) video.addEventListener(event, check)
    video.addEventListener("error", failed, { once: true })

    try {
      const playback = video.play() as Promise<void> | undefined
      if (playback) void playback.then(check, failed)
    } catch {
      failed()
    }
  })
}

/** Centralizes ownership checks and cleanup around asynchronous camera/screen
 * preview startup. Both acquisition modes race mode switches and teardown in
 * exactly the same way. */
export class MediaSourceController {
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly current: () => MediaStream | null,
    private readonly clearCurrent: (stream: MediaStream) => void,
  ) {}

  stop(stream: MediaStream): void {
    stream.getTracks().forEach((track) => track.stop())
    this.clearCurrent(stream)
    if (this.video.srcObject === stream) this.video.srcObject = null
  }

  async preparePreview(
    stream: MediaStream,
    stale: () => boolean,
    prepare: (stream: MediaStream) => Promise<boolean>,
  ): Promise<MediaPreviewResult> {
    if (stale() || this.current() !== stream) {
      this.stop(stream)
      return "stale"
    }
    const ready = await prepare(stream)
    if (stale() || this.current() !== stream) {
      this.stop(stream)
      return "stale"
    }
    if (!ready) {
      this.stop(stream)
      return "no-frame"
    }
    return "ready"
  }
}
