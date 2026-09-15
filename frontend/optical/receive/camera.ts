// Camera acquisition, capability probing, and camera-related status formatting
// live together because they are used only by the standalone receiver entry.

interface CameraOption {
  value: string
  label: string
}

interface CameraOptionState {
  options: CameraOption[]
  selected: string
  disabled: boolean
}

// Chrome-on-Android extensions to the mediacapture spec that lib.dom doesn't
// type. iOS Safari exposes none of them, so every use is capability-gated.
type ExtendedCapabilities = MediaTrackCapabilities & {
  torch?: boolean
  focusMode?: string[]
}

type ExtendedConstraintSet = MediaTrackConstraintSet & {
  torch?: boolean
  focusMode?: string
}

interface CameraCapabilities {
  /** Reported but deliberately unused: the sender is an emissive screen, so a
   * flashlight adds glare, never light the camera was missing. */
  torch: boolean
  continuousFocus: boolean
  maxFrameRate?: number
  maxWidth?: number
}

export type ReceiverPhase = "idle" | "starting" | "searching" | "receiving"

interface CameraReading {
  width?: number
  height?: number
  frameRate?: number
}

export interface RequestedCameraSettings {
  width: number
  frameRate: number
}

/** Screen capture is intentionally hidden on phones and touch-first tablets. */
export function desktopScreenCaptureAvailable(): boolean {
  const mobile = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile
  if (mobile === true) return false
  if (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return false
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

/** Auto prefers the outward-facing camera; an explicit pick pins one lens. */
export function cameraSelection(deviceId: string): MediaTrackConstraints {
  return deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" }
}

export function preferredCameraMode(captureWidth: number, captureFps: number): MediaTrackConstraints {
  return {
    width: captureWidth,
    height: Math.round((captureWidth * 3) / 4),
    frameRate: { ideal: captureFps },
  }
}

/** Acquire the best 4:3 mode near the requested width and frame rate. */
export async function acquireCamera(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  selection: MediaTrackConstraints,
  captureWidth: number,
  captureFps: number,
): Promise<MediaStream> {
  const preferred = preferredCameraMode(captureWidth, captureFps)
  return getUserMedia({
    audio: false,
    video: { ...selection, ...preferred },
  })
}

/** Build a stable camera picker after permission has made device labels available. */
export function cameraOptionState(
  devices: readonly Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[],
  selected: string,
): CameraOptionState {
  const cameras = devices.filter((device) => device.kind === "videoinput")
  const options: CameraOption[] = [{ value: "", label: "Auto (rear camera)" }]
  if (cameras.length >= 2) {
    options.push(
      ...cameras.map((camera, index) => ({
        value: camera.deviceId,
        label: camera.label || `Camera ${index + 1}`,
      })),
    )
  }
  return {
    options,
    selected: cameras.length >= 2 && cameras.some((camera) => camera.deviceId === selected) ? selected : "",
    disabled: cameras.length < 2,
  }
}

export function probeCameraCapabilities(track: MediaStreamTrack): CameraCapabilities {
  const caps: ExtendedCapabilities = track.getCapabilities?.() ?? {}
  return {
    torch: caps.torch === true,
    continuousFocus: Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous"),
    maxFrameRate: caps.frameRate?.max,
    maxWidth: caps.width?.max,
  }
}

/** Best-effort advanced constraint; true when the camera took it. The spec
 * says advanced sets never reject, but Chrome throws for torch anyway. */
export async function applyAdvancedConstraint(track: MediaStreamTrack, set: ExtendedConstraintSet): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [set] })
    return true
  } catch {
    return false
  }
}

function roundedPositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function formatCameraReading(reading?: CameraReading): string {
  if (!reading) return ""
  const width = roundedPositive(reading.width)
  const height = roundedPositive(reading.height)
  const frameRate = roundedPositive(reading.frameRate)
  const resolution = width && height ? `${width}×${height}` : width ? `${width} px wide` : ""
  const fps = frameRate ? `${frameRate} fps` : ""
  return [resolution, fps].filter(Boolean).join(" @ ")
}

export function formatReceiverStatus(phase: ReceiverPhase, reading?: CameraReading): string {
  if (phase === "idle") return "Ready to receive from camera"
  if (phase === "starting") return "Starting camera…"

  const action = phase === "receiving" ? "Receiving QR stream" : "Searching for a QR stream"
  const camera = formatCameraReading(reading)
  return camera ? `${action} · ${camera}` : action
}

function requestedSummary(requested: RequestedCameraSettings): string {
  return `${requested.width} px wide @ ${requested.frameRate} fps`
}

function workerSummary(workerCount: number): string {
  return `${workerCount} decode worker${workerCount === 1 ? "" : "s"}`
}

export function formatPendingReceiverSettings(requested: RequestedCameraSettings, workerCount: number): string {
  return `Will request ${requestedSummary(requested)} · ${workerSummary(workerCount)}`
}

export function formatActiveReceiverSettings(
  reading: CameraReading,
  requested: RequestedCameraSettings,
  workerCount: number,
  captureMode: string,
  note = "changes apply live",
): string {
  const actual = formatCameraReading(reading) || "settings unavailable"
  return (
    `Actual ${actual} · requested ${requestedSummary(requested)} · ${workerSummary(workerCount)} · ` +
    `${captureMode} capture · ${note}`
  )
}
