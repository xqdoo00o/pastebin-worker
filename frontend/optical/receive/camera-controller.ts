import {
  acquireCamera,
  cameraSelection,
  cameraOptionState,
  cameraExposureConstraints,
  CameraSettingsScheduler,
  preferredCameraMode,
  probeCameraCapabilities,
  type CameraCapabilities,
  type CameraSettingsChange,
} from "./camera.js"
import { CAPTURE_FPS_OPTIONS, CAPTURE_WIDTH_OPTIONS, clampToStep, type NumericRange } from "../shared/settings.js"
import { prepareMediaPreview } from "./media-source.js"
import type { ReceiverView } from "./receiver-view.js"
import { errorMessage } from "../../utils/errors.js"

export interface ReceiverCameraPreferences {
  cameraId: string
  captureWidth: number
  captureFps: number
  preferredIso: number
  iso: number
  isoRange: NumericRange
}

interface ReceiverCameraOptions {
  preferences: ReceiverCameraPreferences
  video: HTMLVideoElement
  getStream: () => MediaStream | null
  setStream: (stream: MediaStream | null) => void
  isActive: () => boolean
  view: Pick<ReceiverView, "patch">
  persist: () => void
  reportSettings: (note?: string) => void
  offerRetry: (message: string) => void
  onSwitchStart: () => void
  onSwitchReady: (track: MediaStreamTrack) => void
  restartCapture: (track: MediaStreamTrack) => void
}

/** Owns device selection and live constraints; the receiver owns decode and transfer state. */
export function createReceiverCameraController({
  preferences,
  video,
  getStream,
  setStream,
  isActive,
  view,
  persist,
  reportSettings,
  offerRetry,
  onSwitchStart,
  onSwitchReady,
  restartCapture,
}: ReceiverCameraOptions) {
  let activeCameraCapabilities: CameraCapabilities | undefined
  let generation = 0
  const cameraSettings = new CameraSettingsScheduler(applyCameraSettings, persist, (error) => {
    if (isActive()) reportSettings(`camera settings: ${errorMessage(error)}`)
  })
  async function acquire(isStale: () => boolean): Promise<MediaStream | undefined> {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let captured: MediaStream | undefined
    let cameraError: unknown
    try {
      captured = await acquireCamera(
        getUserMedia,
        cameraSelection(preferences.cameraId),
        preferences.captureWidth,
        preferences.captureFps,
      )
    } catch (err) {
      if (isStale()) return
      cameraError = err
      const denied = err instanceof DOMException && err.name === "NotAllowedError"
      if (preferences.cameraId && !denied) {
        // Device IDs can change when permission/site data is reset. A stale
        // preference must not make the receiver unusable: clear it and retry Auto.
        preferences.cameraId = ""
        view.patch({ cameraId: "" })
        persist()
        try {
          captured = await acquireCamera(
            getUserMedia,
            cameraSelection(""),
            preferences.captureWidth,
            preferences.captureFps,
          )
          cameraError = undefined
        } catch (fallbackError) {
          cameraError = fallbackError
        }
      }
    }
    if (!captured) {
      if (isStale()) return
      const err = cameraError
      const denied = err instanceof DOMException && err.name === "NotAllowedError"
      const gone = err instanceof DOMException && ["NotFoundError", "OverconstrainedError"].includes(err.name)
      offerRetry(
        denied
          ? "camera permission denied — allow it, then tap Start camera again."
          : gone
            ? "the selected camera is no longer available — choose Auto and try again."
            : `camera: ${errorMessage(err)}`,
      )
      return
    }
    return captured
  }

  async function populateCameraOptions(): Promise<void> {
    const attempt = generation
    let devices: MediaDeviceInfo[]
    try {
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch {
      return
    }
    if (!isActive() || attempt !== generation) return
    const state = cameraOptionState(devices, preferences.cameraId)
    view.patch({
      cameraOptions: state.options,
      cameraId: state.selected,
      cameraDisabled: state.disabled,
    })
    if (preferences.cameraId !== state.selected) {
      preferences.cameraId = state.selected
      persist()
    }
  }

  function handleDeviceChange(): void {
    if (getStream() && isActive()) void populateCameraOptions()
  }

  /** Keep the slider and option availability synchronized with the active track. */
  function clearCameraCapabilities(): void {
    generation += 1
    activeCameraCapabilities = undefined
    view.patch({ isoAvailable: false, disabledCaptureFps: [], disabledCaptureWidths: [] })
  }

  function syncCameraCapabilities(track: MediaStreamTrack): CameraCapabilities {
    const caps = probeCameraCapabilities(track)
    activeCameraCapabilities = caps
    const isoAvailable = caps.manualExposure && caps.isoRange !== undefined
    if (isoAvailable && caps.isoRange) {
      preferences.isoRange = caps.isoRange
      preferences.iso = clampToStep(preferences.preferredIso, preferences.isoRange)
    }
    view.patch({
      disabledCaptureFps: caps.maxFrameRate ? CAPTURE_FPS_OPTIONS.filter((value) => value > caps.maxFrameRate!) : [],
      disabledCaptureWidths: caps.maxWidth ? CAPTURE_WIDTH_OPTIONS.filter((value) => value > caps.maxWidth!) : [],
      iso: preferences.iso,
      isoRange: preferences.isoRange,
      isoAvailable,
    })
    return caps
  }

  function isActiveCameraTrack(track: MediaStreamTrack): boolean {
    return isActive() && track === getStream()?.getVideoTracks()[0]
  }

  /** Apply manual exposure and ISO after the camera mode, retaining automatic focus. */
  async function applyCameraExposure(
    track: MediaStreamTrack,
    capabilities: CameraCapabilities,
  ): Promise<"unavailable" | "applied" | "refused"> {
    const constraints = cameraExposureConstraints(preferences.iso, capabilities)
    if (!constraints) return "unavailable"
    try {
      await track.applyConstraints(constraints)
      return "applied"
    } catch {
      // Keep the negotiated camera mode if a live reconfiguration is refused.
      return "refused"
    }
  }

  async function initializeCameraTrack(track: MediaStreamTrack): Promise<void> {
    if (!isActiveCameraTrack(track)) return
    const capabilities = syncCameraCapabilities(track)
    await applyCameraExposure(track, capabilities)
  }

  /**
   * Switch lenses without discarding fountain state. Capture and QR decode
   * workers are restarted so no late frame from the old camera reaches NanoRQ.
   */
  async function switchCamera(): Promise<void> {
    if (!isActive() || !getStream()) return
    cameraSettings.cancel()
    clearCameraCapabilities()
    const attempt = generation
    const isCurrent = () => isActive() && generation === attempt
    const previousStream = getStream()!
    const previousDeviceId = previousStream.getVideoTracks()[0]?.getSettings().deviceId ?? ""
    const requestedDeviceId = preferences.cameraId
    view.patch({ cameraDisabled: true, cameraActual: "Switching camera…" })
    onSwitchStart()
    previousStream.getTracks().forEach((track) => track.stop())
    setStream(null)
    video.srcObject = null

    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let nextStream: MediaStream
    let restoredPrevious = false
    try {
      nextStream = await acquireCamera(
        getUserMedia,
        cameraSelection(requestedDeviceId),
        preferences.captureWidth,
        preferences.captureFps,
      )
    } catch {
      if (!isCurrent()) return
      try {
        nextStream = await acquireCamera(
          getUserMedia,
          cameraSelection(previousDeviceId),
          preferences.captureWidth,
          preferences.captureFps,
        )
        restoredPrevious = true
      } catch {
        if (!isCurrent()) return
        view.patch({ cameraDisabled: false })
        offerRetry("the camera could not be restarted — choose another camera and try again.")
        return
      }
    }

    if (!isCurrent()) {
      nextStream.getTracks().forEach((track) => track.stop())
      return
    }

    setStream(nextStream)
    const releaseIfStale = () => {
      if (isCurrent() && getStream() === nextStream) return false
      nextStream.getTracks().forEach((track) => track.stop())
      if (video.srcObject === nextStream) video.srcObject = null
      return true
    }
    await initializeCameraTrack(nextStream.getVideoTracks()[0])
    if (releaseIfStale()) return
    const previewReady = await prepareMediaPreview(video, nextStream)
    if (releaseIfStale()) return
    if (!previewReady) {
      nextStream.getTracks().forEach((track) => track.stop())
      setStream(null)
      if (video.srcObject === nextStream) video.srcObject = null
      view.patch({ cameraDisabled: false })
      offerRetry("the camera restarted, but its preview did not produce a video frame — try again.")
      return
    }
    onSwitchReady(nextStream.getVideoTracks()[0])
    view.patch({ cameraDisabled: false })
    if (restoredPrevious) preferences.cameraId = previousDeviceId
    await populateCameraOptions()
    if (!isCurrent()) return
    reportSettings(restoredPrevious ? "selected camera unavailable; kept the previous camera" : "changes apply live")
  }

  async function applyCameraSettings(kind: CameraSettingsChange): Promise<void> {
    if (!isActive()) return
    const track = getStream()?.getVideoTracks()[0]
    if (!track) return
    const applyMode = kind === "mode"
    let capabilities = activeCameraCapabilities ?? syncCameraCapabilities(track)
    let modeApplied = false
    let note = "changes apply live"
    reportSettings(applyMode ? "applying camera settings…" : "applying ISO…")
    if (applyMode) {
      try {
        await track.applyConstraints(preferredCameraMode(preferences.captureWidth, preferences.captureFps))
        if (!isActiveCameraTrack(track)) return
        modeApplied = true
        capabilities = syncCameraCapabilities(track)
      } catch {
        // Some devices (notably iOS) refuse a live reconfigure. Keep the stream
        // we have rather than tearing down a transfer in progress.
        note = "camera refused the live change; restart to apply"
      }
      if (!isActiveCameraTrack(track)) return
    }
    const exposureResult = await applyCameraExposure(track, capabilities)
    if (!isActiveCameraTrack(track)) return
    if (exposureResult === "refused" && note === "changes apply live") note = "camera refused the ISO change"
    // The transfer may have completed while applyConstraints was pending. Do not
    // recreate capture infrastructure that finish() has already torn down.
    // A transferred clone has its own constraints. Recreate the worker source
    // immediately after a camera width/fps change so capture does not wait for
    // the actual-settings UI to settle. Other capture modes consume the original
    // track and update in place.
    if (modeApplied) restartCapture(track)
    // Give the camera mode 1 s to settle before displaying the track's actual
    // dimensions and frame rate. This also covers teardown or camera switching
    // during the UI-only settling delay.
    if (modeApplied) await new Promise<void>((resolve) => window.setTimeout(resolve, 1000))
    if (!isActiveCameraTrack(track)) return
    reportSettings(note)
  }

  navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange)
  return {
    acquire,
    populateOptions: populateCameraOptions,
    initializeTrack: initializeCameraTrack,
    switchCamera,
    clearCapabilities: clearCameraCapabilities,
    schedule: (kind: CameraSettingsChange) => cameraSettings.schedule(kind),
    cancel: () => cameraSettings.cancel(),
    dispose() {
      generation += 1
      cameraSettings.cancel()
      navigator.mediaDevices?.removeEventListener("devicechange", handleDeviceChange)
    },
  }
}
