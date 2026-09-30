// Camera acquisition, capability probing, and camera-related status formatting
// live together because they are used only by the standalone receiver entry.

import { DEFAULT_CAMERA_ISO_RANGE, clampToStep, type NumericRange } from "../shared/settings.js"

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
  exposureMode?: string[]
  exposureTime?: { min?: number; max?: number; step?: number }
  iso?: { min?: number; max?: number; step?: number }
}

type ExtendedConstraintSet = MediaTrackConstraintSet & {
  exposureMode?: string
  exposureTime?: number
  iso?: number
}

export const CAMERA_EXPOSURE_TIME = 20

export interface CameraCapabilities {
  maxFrameRate?: number
  maxWidth?: number
  isoRange?: NumericRange
  manualExposure: boolean
  exposureTimeRange?: NumericRange
}

export type ReceiverPhase = "idle" | "starting" | "searching" | "receiving"

interface CameraReading {
  width?: number
  height?: number
  frameRate?: number
  iso?: number
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

/** Build only constraints the active camera reports supporting. Focus remains
 * under the device's default automatic control. */
export function cameraExposureConstraints(
  iso: number,
  capabilities: CameraCapabilities,
): MediaTrackConstraints | undefined {
  if (!capabilities.manualExposure || !capabilities.isoRange) return undefined
  const set: ExtendedConstraintSet = {
    exposureMode: "manual",
    iso: clampToStep(iso, capabilities.isoRange),
  }
  if (capabilities.exposureTimeRange) {
    set.exposureTime = clampToStep(CAMERA_EXPOSURE_TIME, capabilities.exposureTimeRange)
  }
  return { advanced: [set] }
}

export type CameraSettingsChange = "exposure" | "mode"

/** Coalesce slider updates and serialize camera constraints. Mode changes
 * preempt the ISO throttle; cancellation also persists the last ISO choice. */
export class CameraSettingsScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: CameraSettingsChange | undefined
  private applying = false
  private isoDirty = false

  constructor(
    private readonly apply: (kind: CameraSettingsChange) => Promise<void>,
    private readonly persist: () => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  schedule(kind: CameraSettingsChange): void {
    if (kind === "exposure") this.isoDirty = true
    if (kind === "mode" || this.pending === undefined) this.pending = kind
    this.arm(kind === "mode" ? 0 : 120, kind === "mode")
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    this.persistIso()
  }

  private persistIso(): void {
    if (!this.isoDirty) return
    this.isoDirty = false
    this.persist()
  }

  private arm(delay: number, expedite = false): void {
    if (this.applying) return
    if (this.timer !== undefined) {
      if (!expedite) return
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
  }

  private async flush(): Promise<void> {
    if (this.applying || this.pending === undefined) return
    const kind = this.pending
    this.pending = undefined
    this.applying = true
    try {
      this.persistIso()
      await this.apply(kind)
    } catch (error) {
      this.onError(error)
    } finally {
      this.applying = false
      if (this.pending !== undefined) this.arm(0)
    }
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
    maxFrameRate: positiveNumber(caps.frameRate?.max),
    maxWidth: positiveNumber(caps.width?.max),
    isoRange: completePositiveRange(caps.iso, DEFAULT_CAMERA_ISO_RANGE.step),
    manualExposure: Array.isArray(caps.exposureMode) && caps.exposureMode.includes("manual"),
    exposureTimeRange: completePositiveRange(caps.exposureTime, 1),
  }
}

function completePositiveRange(
  range: { min?: number; max?: number; step?: number } | undefined,
  fallbackStep: number,
): NumericRange | undefined {
  const min = positiveNumber(range?.min)
  const max = positiveNumber(range?.max)
  if (min === undefined || max === undefined || min > max) return undefined
  return { min, max, step: positiveNumber(range?.step) ?? fallbackStep }
}

function roundedPositive(value: number | undefined): number | undefined {
  const positive = positiveNumber(value)
  return positive === undefined ? undefined : Math.round(positive)
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
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

function formatCameraIso(reading: CameraReading): string {
  const iso = roundedPositive(reading.iso)
  if (!iso) return "ISO not reported"
  return `ISO ${iso}`
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
  workerCount: number,
  captureBackend: string,
  note = "changes apply live",
  showIso = true,
): string {
  const actual = formatCameraReading(reading) || "settings unavailable"
  const segments = [`Actual ${actual}`]
  if (showIso) segments.push(formatCameraIso(reading))
  segments.push(workerSummary(workerCount), captureBackend, note)
  return segments.join(" · ")
}
