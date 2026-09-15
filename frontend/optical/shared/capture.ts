// Camera-frame helpers and the small message contract shared by the receiver
// and its capture worker. Keeping the capture domain together avoids one-file
// modules for each protocol/type group without coupling the worker entries.

export type CaptureWorkerInput =
  { type: "probe" } | { type: "start"; track: MediaStreamTrack } | { type: "next" } | { type: "stop" }

export type CaptureWorkerOutput =
  | { type: "support"; supported: boolean }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "frame"; frame: VideoFrame }
  | { type: "error"; message: string }

export interface MediaStreamTrackProcessorLike {
  readonly readable: ReadableStream<VideoFrame>
}

export type MediaStreamTrackProcessorConstructor = new (init: {
  track: MediaStreamTrack
  maxBufferSize?: number
}) => MediaStreamTrackProcessorLike

/** Eight-bit YUV formats whose first plane is directly usable as luminance. */
export type LumaVideoFormat = "I420" | "I420A" | "I422" | "I444" | "NV12"

export function isLumaVideoFormat(format: string | null): format is LumaVideoFormat {
  switch (format) {
    case "I420":
    case "I420A":
    case "I422":
    case "I444":
    case "NV12":
      return true
    default:
      return false
  }
}

export interface TightPlaneLayout {
  offset: number
  stride: number
}

export interface TightVideoFrameLayout {
  layout: TightPlaneLayout[]
  /** Exact destination size implied by `layout`. */
  byteLength: number
}

/** Lay every plane back-to-back while keeping plane 0 as packed width×height Y.
 *
 * WebCodecs copyTo() requires a destination layout for every plane. QR decode
 * reads only Y, but the chroma/alpha planes still need valid, non-overlapping
 * storage after it. All formats here use one byte per component sample. */
export function tightVideoFrameLayout(
  format: LumaVideoFormat,
  width: number,
  height: number,
  reuse?: TightVideoFrameLayout,
): TightVideoFrameLayout {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("VideoFrame layout dimensions must be positive integers")
  }

  const target = reuse ?? { layout: [], byteLength: 0 }
  const layout = target.layout
  let plane = 0
  let offset = 0
  const addPlane = (stride: number, rows: number): void => {
    const entry = layout[plane] ?? { offset: 0, stride: 0 }
    entry.offset = offset
    entry.stride = stride
    layout[plane++] = entry
    offset += stride * rows
  }

  addPlane(width, height) // Y
  const halfWidth = Math.ceil(width / 2)
  const halfHeight = Math.ceil(height / 2)
  switch (format) {
    case "I420":
      addPlane(halfWidth, halfHeight) // U
      addPlane(halfWidth, halfHeight) // V
      break
    case "I420A":
      addPlane(halfWidth, halfHeight) // U
      addPlane(halfWidth, halfHeight) // V
      addPlane(width, height) // A
      break
    case "I422":
      addPlane(halfWidth, height) // U
      addPlane(halfWidth, height) // V
      break
    case "I444":
      addPlane(width, height) // U
      addPlane(width, height) // V
      break
    case "NV12":
      addPlane(halfWidth * 2, halfHeight) // interleaved UV
      break
  }

  layout.length = plane
  target.byteLength = offset
  return target
}
