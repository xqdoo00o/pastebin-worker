// React receiver controller: camera → WASM QR decode workers → fountain decoder → file.
//
// Field lessons baked in:
// - Camera resolution and frame rate modes are coupled. Width/height are direct
//   preferences; frame rate stays explicitly ideal.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress tracks distinct RFC 6330 symbols collected; matrix recovery is
//   atomic, so there is no meaningful per-source-symbol solved count.
// - Android Chrome exposes torch / focusMode / frameRate.max through
//   getCapabilities; iOS Safari exposes none of them. Camera helpers own the
//   probing, so everything here is capability-gated rather than UA-gated.

import { P2PWakeLock } from "../../utils/p2p/wakeLock.js"
import { DecodeWorkerPool, type PoolWorker } from "../shared/worker-pool.js"
import { ensureZstdDecoderReady } from "../../wasm/zstd-loader.js"
import {
  CAPTURE_FPS_OPTIONS,
  CAPTURE_WIDTH_OPTIONS,
  loadOpticalReceiverSettings,
  saveOpticalReceiverSettings,
} from "../shared/settings.js"
import type { DecodeWorkerOutput } from "../shared/worker-messages.js"
import { loadNanoRQCodecModule } from "../shared/wasm-module.js"
import { loadOpticalCodecModule } from "../codec/wasm-module.js"
import {
  acquireCamera,
  applyAdvancedConstraint,
  cameraOptionState,
  cameraSelection,
  desktopScreenCaptureAvailable,
  formatActiveReceiverSettings,
  formatPendingReceiverSettings,
  formatReceiverStatus,
  preferredCameraMode,
  probeCameraCapabilities,
  type ReceiverPhase,
  type RequestedCameraSettings,
} from "./camera.js"
import { CapturePipeline } from "./capture-pipeline.js"
import { MediaSourceController, prepareMediaPreview } from "./media-source.js"
import { MultipartOpticalAssembler, OpticalPartTransferMismatchError } from "./part-assembler.js"
import { ReceiverView, type ReceiveMode, type ReceiverUiState } from "./receiver-view.js"
import { ReceiverPreviewLayout } from "./preview-layout.js"
import { errorMessage, isAbortError } from "../../utils/errors.js"
import { FountainWorkerClient } from "./fountain-client.js"
import { ApngDecodeSource } from "./apng-source.js"
import {
  NO_READABLE_APNG_QR_MESSAGE,
  OpticalReceiverRuntime,
  ReceivedFileResource,
  ReceiverSession,
} from "./receiver-runtime.js"
import { createOpticalDecodeWorker } from "./worker-factory.js"
import { ReceiverTransferCoordinator } from "./receiver-transfer.js"

export interface OpticalReceiverElements {
  video: HTMLVideoElement
  preview: HTMLElement
  cameraBox: HTMLDivElement
  progressBar: HTMLElement
}

export interface OpticalReceiverController {
  start(): void
  switchMode(mode: ReceiveMode): void
  selectApng(file: File): void
  updateCaptureWidth(value: number): void
  updateCaptureFps(value: number): void
  updateWorkerCount(value: number): void
  updateCamera(value: string): void
  reset(): void
  resetParts(): void
  markDownloadStarted(): void
  dispose(): void
}

/** Match the decode-worker ceiling to the browser's reported logical processors. */
export function opticalDecodeWorkerLimit(hardwareConcurrency = navigator.hardwareConcurrency): number {
  return Math.max(1, hardwareConcurrency || 6)
}

/** Leave two logical processors available for capture, rendering and the UI. */
export function opticalDefaultDecodeWorkerCount(workerLimit: number): number {
  return Math.max(1, workerLimit - 2)
}

export function createOpticalReceiverController(
  { video, preview, cameraBox, progressBar: bar }: OpticalReceiverElements,
  updateState: (updater: (state: ReceiverUiState) => ReceiverUiState) => void,
): OpticalReceiverController {
  // Start fetching and compiling when React mounts the receiver controller,
  // before camera permission and preview setup.
  void loadOpticalCodecModule().catch(() => undefined)
  void loadNanoRQCodecModule().catch(() => undefined)
  void ensureZstdDecoderReady().catch(() => undefined)
  let opticalCodecModule: WebAssembly.Module | undefined
  let disposed = false

  const desktopScreenAvailable = desktopScreenCaptureAvailable()
  const workerLimit = opticalDecodeWorkerLimit()
  const workerOptions = Array.from({ length: workerLimit }, (_, index) => index + 1)
  const restoredReceiverSettings = loadOpticalReceiverSettings(
    {
      cameraId: "",
      captureWidth: 1280,
      captureFps: 60,
      workers: opticalDefaultDecodeWorkerCount(workerLimit),
    },
    { captureWidths: CAPTURE_WIDTH_OPTIONS, captureFps: CAPTURE_FPS_OPTIONS, workers: workerOptions },
  )
  let preferredCameraId = restoredReceiverSettings.cameraId
  let captureWidth = restoredReceiverSettings.captureWidth
  let captureFps = restoredReceiverSettings.captureFps
  let workerCount = restoredReceiverSettings.workers
  const receiverView = new ReceiverView((updater) => {
    if (!disposed) updateState(updater)
  })
  receiverView.patch({ cameraId: preferredCameraId, captureWidth, captureFps, workers: workerCount })

  let stream: MediaStream | null = null
  const receiverRuntime = new OpticalReceiverRuntime()
  const receiverSession = new ReceiverSession<ReceiveMode>("camera")
  const multipartAssembler = new MultipartOpticalAssembler()
  const fountainClient = new FountainWorkerClient({
    onMessage: (message) => transferCoordinator.handleMessage(message),
    onFatal: (message) => {
      if (!receiverSession.done) void teardownReceiver().then(() => offerRetry(message))
    },
    isDone: () => receiverSession.done,
  })

  const receiverWakeLock = new P2PWakeLock(() => undefined)
  const pool = new DecodeWorkerPool(
    () => createDecodeWorker(),
    () => capturePipeline.noteVideoFrameCopyError(),
    (error) => {
      if (receiverSession.done) return
      if (receiverSession.mode !== "apng" || !receiverRuntime.rejectApngAttempt(error)) {
        void teardownReceiver().then(() => offerRetry(`QR decoder worker: ${error.message}`))
      }
    },
    (output) => handleDecodeTaskComplete(output),
    (error) => {
      if (!receiverSession.done && receiverSession.mode === "apng") receiverRuntime.rejectApngAttempt(error)
    },
  )
  const apngDecodeSource = new ApngDecodeSource({
    pool,
    isStale: (generation) => stale("apng", generation),
    onFrameTotal: (total) => {
      receiverRuntime.apngFrameTotal = total
    },
  })
  const capturePipeline = new CapturePipeline({
    video,
    pool,
    isDone: () => receiverSession.done,
    onModeChange: () => reportReceiverSettings(),
    forceReadback: new URLSearchParams(window.location.search).get("capture") === "readback",
  })
  // WASM compilation starts with the page. Start waits for both Modules before
  // requesting a camera, while workers stay lazy until its preview is running.
  const receivedFileResource = new ReceivedFileResource()
  const transferCoordinator = new ReceiverTransferCoordinator({
    progressBar: bar,
    runtime: receiverRuntime,
    session: receiverSession,
    view: receiverView,
    assembler: multipartAssembler,
    fountainClient,
    receivedFile: receivedFileResource,
    setReceiverPhase: (phase) => setReceiverPhase(phase),
    renderReceiverStatus,
    showError,
    offerRetry,
    teardownReceiver,
    suspendReceiver,
    releaseDecodeWorkers,
    resetReceiver,
  })

  function createDecodeWorker(): PoolWorker {
    if (!opticalCodecModule) throw new Error("optical codec was not preloaded")
    const worker = createOpticalDecodeWorker()
    return fountainClient.connectDecodeWorker(worker, opticalCodecModule)
  }

  const mediaSource = new MediaSourceController(
    video,
    () => stream,
    (activeStream) => {
      if (stream === activeStream) stream = null
    },
  )

  /** Keeps the preview's visible box aligned with the full decode frame. */
  const previewLayout = new ReceiverPreviewLayout(video, preview, cameraBox)
  const syncPreviewAspect = () => previewLayout.sync()
  const resetPreviewLayout = () => previewLayout.reset()
  function reportScreenResize(): void {
    if (receiverSession.mode !== "screen" || receiverSession.done || !stream) return
    // Give the track one task to publish its new settings before reading them.
    window.setTimeout(() => {
      if (receiverSession.mode === "screen" && !receiverSession.done && stream)
        reportReceiverSettings("capture size changed")
    }, 0)
  }

  // Fires whenever the intrinsic size changes — device rotation, a live camera
  // reconfigure, or a shared-screen window resize. Display-capture tracks do not
  // consistently expose a resize event, so the video element is the portable
  // signal for this update.
  video.addEventListener("resize", syncPreviewAspect)
  video.addEventListener("resize", reportScreenResize)
  video.addEventListener("loadedmetadata", syncPreviewAspect)
  window.addEventListener("resize", syncPreviewAspect)
  window.visualViewport?.addEventListener("resize", syncPreviewAspect)

  function persistReceiverSettings(): void {
    saveOpticalReceiverSettings({
      cameraId: preferredCameraId,
      captureWidth,
      captureFps,
      workers: workerCount,
    })
  }

  function requestedCameraSettings(): RequestedCameraSettings {
    return { width: captureWidth, frameRate: captureFps }
  }

  function renderReceiverStatus(): void {
    if (receiverSession.mode === "apng") {
      receiverView.showStatus(
        receiverRuntime.phase === "idle"
          ? "Ready to receive from an APNG file"
          : receiverRuntime.phase === "starting"
            ? "Preparing APNG decoder…"
            : receiverRuntime.phase === "receiving" && receiverRuntime.apngFrameTotal
              ? `Receiving APNG · frame ${receiverRuntime.apngFrameNumber}/${receiverRuntime.apngFrameTotal}`
              : "Searching APNG for QR symbols",
      )
      return
    }
    if (receiverSession.mode === "screen") {
      receiverView.showStatus(
        receiverRuntime.phase === "idle"
          ? "Ready to receive from a shared screen"
          : receiverRuntime.phase === "starting"
            ? "Starting screen capture…"
            : receiverRuntime.phase === "receiving"
              ? "Receiving QR stream from shared screen"
              : "Searching shared screen for a QR stream",
      )
      return
    }
    const reading = stream?.getVideoTracks()[0]?.getSettings()
    receiverView.showStatus(formatReceiverStatus(receiverRuntime.phase, reading))
  }

  function setReceiverPhase(phase: ReceiverPhase): void {
    receiverRuntime.phase = phase
    renderReceiverStatus()
  }

  function showError(message: string): void {
    receiverView.showError(message)
  }

  function updateReceiveModeUi(): void {
    receiverView.updateMode(receiverSession.mode)
  }

  async function switchReceiveMode(next: ReceiveMode): Promise<void> {
    if (receiverSession.mode === next) return
    // Publish the requested mode before cleanup starts. A rapid A -> B -> A
    // sequence can then supersede the first transition instead of being mistaken
    // for a no-op while B is still tearing A down.
    const transition = receiverSession.beginModeTransition(next)
    await teardownReceiver()
    if (!receiverSession.isCurrentTransition(transition)) return
    resetReceiver()
    updateReceiveModeUi()
  }

  function reportPendingReceiverSettings(): void {
    if (receiverSession.mode === "screen") {
      receiverView.patch({ cameraActual: `Will request ${captureFps} fps · ${workerCount} decode workers` })
      return
    }
    receiverView.patch({ cameraActual: formatPendingReceiverSettings(requestedCameraSettings(), workerCount) })
  }
  reportPendingReceiverSettings()
  updateReceiveModeUi()

  /** Put the page back the way it was so a refused camera can be retried without
   *  a reload. Tapping "Block" by accident on the permission prompt is easy, and
   *  a dead page with no button is a bad answer to it. */
  function offerRetry(message: string) {
    stopUpdateTimer()
    receiverView.offerRetry(receiverSession.mode, message)
  }

  function stopUpdateTimer(): void {
    receiverRuntime.stopUpdateTimer()
  }

  async function populateCameraOptions(): Promise<void> {
    let devices: MediaDeviceInfo[]
    try {
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch {
      return
    }
    if (receiverSession.done) return
    const state = cameraOptionState(devices, preferredCameraId)
    receiverView.patch({
      cameraOptions: state.options,
      cameraId: state.selected,
      cameraDisabled: state.disabled,
    })
    if (preferredCameraId !== state.selected) {
      preferredCameraId = state.selected
      persistReceiverSettings()
    }
  }

  function handleDeviceChange(): void {
    if (stream && !receiverSession.done) void populateCameraOptions()
  }

  navigator.mediaDevices?.addEventListener("devicechange", handleDeviceChange)

  function handleDecodeTaskComplete(output: DecodeWorkerOutput): void {
    fountainClient.recordSubmitted(output.forwardedSymbols)
    if (receiverSession.done) return
    if (!output.apng || receiverSession.done || receiverSession.mode !== "apng") return
    if (output.error) {
      receiverRuntime.rejectApngAttempt(new Error(output.error))
      return
    }
    if (receiverRuntime.rejectUnreadableFirstApngFrame(output.apng.index, output.forwardedSymbols)) return
    receiverRuntime.noteApngFrame(output.apng.total)
    renderReceiverStatus()
    apngDecodeSource.credit()
  }

  function abortApngParser(): void {
    apngDecodeSource.abort()
    receiverRuntime.rejectApngAttempt(new Error("APNG decoding was cancelled."))
  }

  async function startApng(file: File): Promise<void> {
    if (receiverSession.mode !== "apng" || receiverSession.done) return
    const generation = receiverSession.beginAttempt()
    setReceiverPhase("starting")
    receiverView.patch({ apngInputDisabled: true })
    try {
      const [module] = await Promise.all([loadOpticalCodecModule(), loadNanoRQCodecModule()])
      opticalCodecModule ??= module
      await fountainClient.ensure()
      if (!receiverSession.isCurrent("apng", generation)) return

      receiverView.patch({ previewVisible: true, startVisible: false })
      pool.resize(workerCount)
      receiverRuntime.resetApngFrames()
      setReceiverPhase("searching")

      let rejectDecode!: (error: Error) => void
      const decodeFailure = new Promise<never>((_resolve, reject) => {
        rejectDecode = reject
      })
      receiverRuntime.setApngAttemptRejector(rejectDecode)
      await Promise.race([apngDecodeSource.parse(file, generation), decodeFailure])

      // Decode-worker completion happens before the fountain worker consumes
      // queued QR payloads, so wait for both before deciding this APNG failed.
      // A delivered part of a multi-part transfer is success, not failure.
      await Promise.race([pool.whenIdle(), decodeFailure])
      // Decode completion and fountain acknowledgement travel over independent
      // channels, so compare cumulative counts instead of maintaining a pending
      // value that can be decremented before its matching completion arrives.
      await Promise.race([fountainClient.waitForDrain(), decodeFailure])
      if (receiverSession.isCurrent("apng", generation) && !receiverSession.attemptDelivered) {
        await teardownReceiver()
        offerRetry(
          receiverRuntime.snapshot
            ? "This APNG did not contain enough QR frames to recover the transfer."
            : NO_READABLE_APNG_QR_MESSAGE,
        )
      }
    } catch (error) {
      if (stale("apng", generation)) return
      if (error instanceof OpticalPartTransferMismatchError && multipartAssembler.progress()) {
        await suspendReceiver()
        resetReceiver()
        showError(error.message)
        return
      }
      await teardownReceiver()
      if (!receiverSession.done) {
        const message = errorMessage(error)
        offerRetry(message === NO_READABLE_APNG_QR_MESSAGE ? message : `APNG: ${message}`)
      }
    } finally {
      receiverRuntime.clearApngAttempt()
    }
  }

  /** True once the receiver has been torn down, switched modes, or superseded by
   * a newer generation — any async step should stop and release its stream. */
  function stale(mode: ReceiveMode, generation: number): boolean {
    return !receiverSession.isCurrent(mode, generation)
  }

  /** Load the compiled codec Modules once, surfacing a mode-appropriate decoder
   * error. Returns false when the caller should stop (load failed or receiver
   * moved on). */
  async function ensureCodecModules(mode: ReceiveMode, generation: number): Promise<boolean> {
    try {
      const [module] = await Promise.all([loadOpticalCodecModule(), loadNanoRQCodecModule()])
      opticalCodecModule ??= module
    } catch (err) {
      if (!stale(mode, generation)) offerRetry(`decoder: ${errorMessage(err)}`)
      return false
    }
    return !stale(mode, generation)
  }

  /** Create the stateful NanoRQ worker only after the stream and preview are
   * ready. On failure or a raced teardown, stop the active stream and return
   * false. */
  async function ensureFountainWorkerFor(
    mode: ReceiveMode,
    generation: number,
    activeStream: MediaStream,
  ): Promise<boolean> {
    try {
      await fountainClient.ensure()
    } catch (err) {
      await teardownReceiver()
      if (receiverSession.isCurrent(mode, generation)) {
        offerRetry(`decoder: ${errorMessage(err)}`)
      }
      return false
    }
    if (stale(mode, generation) || stream !== activeStream) {
      mediaSource.stop(activeStream)
      return false
    }
    return true
  }

  /** Start the decode pipeline once the stream, preview, and fountain worker are
   * all live: reveal the viewfinder, size the pool, report the negotiated
   * settings, and drive the capture loop. */
  function startPipeline(track: MediaStreamTrack, mode: "camera" | "screen") {
    syncPreviewAspect()
    receiverView.patch({ startVisible: false, previewVisible: true })
    pool.resize(workerCount)
    setReceiverPhase("searching")
    if (mode === "camera") {
      void applyCameraExtras()
      void populateCameraOptions()
    }
    reportReceiverSettings()
    capturePipeline.start(track)
    if (mode === "camera") reportReceiverSettings()
    receiverRuntime.startUpdateTimer(updateReceiverState)
    void receiverWakeLock.start()
  }

  async function startScreen(): Promise<void> {
    const generation = receiverSession.beginAttempt()
    if (!desktopScreenAvailable) return
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showError("screen capture is unavailable in this browser or requires a secure context.")
      return
    }
    setReceiverPhase("starting")
    receiverView.patch({ startDisabled: true, startLabel: "Starting…" })
    // for safari
    // if (!(await ensureCodecModules("screen", generation))) return

    let captured: MediaStream
    try {
      captured = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: captureFps } },
        audio: false,
      })
    } catch (err) {
      if (stale("screen", generation)) return
      const cancelled = isAbortError(err)
      offerRetry(cancelled ? "screen sharing was cancelled." : `screen capture: ${errorMessage(err)}`)
      return
    }
    const activeStream = captured
    const track = activeStream.getVideoTracks()[0]
    if (!track) {
      mediaSource.stop(activeStream)
      if (receiverSession.isCurrent("screen", generation)) offerRetry("no video track was shared.")
      return
    }
    // for safari
    if (!(await ensureCodecModules("screen", generation))) {
      mediaSource.stop(activeStream)
      return
    }
    stream = activeStream
    const previewResult = await mediaSource.preparePreview(
      activeStream,
      () => stale("screen", generation),
      (activeStream) => prepareMediaPreview(video, activeStream),
    )
    if (previewResult === "stale") return
    if (previewResult === "no-frame") {
      if (receiverSession.isCurrent("screen", generation)) {
        offerRetry("screen capture opened, but its preview did not produce a video frame — try again.")
      }
      return
    }

    if (!(await ensureFountainWorkerFor("screen", generation, activeStream))) return

    track.addEventListener(
      "ended",
      () => {
        if (stale("screen", generation)) return
        void teardownReceiver().then(() => offerRetry("screen sharing stopped — choose Screen and try again."))
      },
      { once: true },
    )
    startPipeline(track, "screen")
  }

  async function start() {
    if (receiverSession.mode === "screen") {
      await startScreen()
      return
    }
    const generation = receiverSession.beginAttempt()
    if (!navigator.mediaDevices?.getUserMedia) {
      // On insecure origins the API doesn't exist AT ALL — this is the plain-
      // http-over-LAN case. localhost is exempt; other hosts need https.
      showError(
        "camera needs a secure context — this page must be served over https to " +
          "use the camera from another device. `npm run dev` already is.",
      )
      return
    }
    setReceiverPhase("starting")
    // Nothing on the page changes until the camera is actually running: the
    // error paths below all have to leave a usable Start button behind.
    receiverView.patch({ startDisabled: true, startLabel: "Starting…" })
    if (!(await ensureCodecModules("camera", generation))) return
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let cameraError: unknown
    try {
      stream = await acquireCamera(getUserMedia, cameraSelection(preferredCameraId), captureWidth, captureFps)
    } catch (err) {
      cameraError = err
      const denied = err instanceof DOMException && err.name === "NotAllowedError"
      if (preferredCameraId && !denied) {
        // Device IDs can change when permission/site data is reset. A stale
        // preference must not make the receiver unusable: clear it and retry Auto.
        preferredCameraId = ""
        receiverView.patch({ cameraId: "" })
        persistReceiverSettings()
        try {
          stream = await acquireCamera(getUserMedia, cameraSelection(""), captureWidth, captureFps)
          cameraError = undefined
        } catch (fallbackError) {
          cameraError = fallbackError
        }
      }
    }
    if (!stream) {
      if (stale("camera", generation)) return
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
    const activeStream = stream
    const previewResult = await mediaSource.preparePreview(
      activeStream,
      () => stale("camera", generation),
      (activeStream) => prepareMediaPreview(video, activeStream),
    )
    if (previewResult === "stale") return
    if (previewResult === "no-frame") {
      if (receiverSession.isCurrent("camera", generation)) {
        offerRetry("camera opened, but its preview did not produce a video frame — try again.")
      }
      return
    }

    // Camera permission, stream acquisition, and the first preview frame have
    // all succeeded. Only now create the stateful NanoRQ worker; abandoning the
    // camera prompt or failing to open a camera leaves no worker behind.
    if (!(await ensureFountainWorkerFor("camera", generation, activeStream))) return

    startPipeline(activeStream.getVideoTracks()[0], "camera")
  }

  /** Report what the source actually negotiated — iOS in particular will happily
   *  hand back 30 fps after accepting a request for 60. */
  function reportReceiverSettings(note = "changes apply live") {
    const track = stream?.getVideoTracks()[0]
    if (!track) return
    const settings = track.getSettings()
    if (receiverSession.mode === "screen") {
      const width =
        settings.width && settings.height ? `${settings.width}×${settings.height}` : "resolution unavailable"
      const fps = settings.frameRate ? ` @ ${Math.round(settings.frameRate)} fps` : ""
      receiverView.patch({
        cameraActual: `Actual ${width}${fps} · ${pool.size} decode workers · ${capturePipeline.mode} capture · ${note}`,
      })
    } else {
      receiverView.patch({
        cameraActual: formatActiveReceiverSettings(
          settings,
          requestedCameraSettings(),
          pool.size,
          capturePipeline.mode,
          note,
        ),
      })
    }
    renderReceiverStatus()
  }

  /** Use what this camera can actually do, probed rather than UA-sniffed.
   *  Continuous autofocus is applied silently — a lens hunting between frames is
   *  the top decode killer, and a camera that refuses is left as it was. Frame
   *  rates the current mode can't reach are grayed out. */
  async function applyCameraExtras() {
    const track = stream?.getVideoTracks()[0]
    if (!track) return
    const caps = probeCameraCapabilities(track)
    if (caps.continuousFocus) {
      await applyAdvancedConstraint(track, { focusMode: "continuous" })
    }
    if (receiverSession.done || track !== stream?.getVideoTracks()[0]) return
    receiverView.patch({
      disabledCaptureFps: caps.maxFrameRate ? CAPTURE_FPS_OPTIONS.filter((value) => value > caps.maxFrameRate!) : [],
      disabledCaptureWidths: caps.maxWidth ? CAPTURE_WIDTH_OPTIONS.filter((value) => value > caps.maxWidth!) : [],
    })
  }

  /**
   * Switch lenses without discarding fountain state. Capture and QR decode
   * workers are restarted so no late frame from the old camera reaches NanoRQ.
   */
  async function switchCamera(): Promise<void> {
    if (receiverSession.done || !stream) return
    const previousStream = stream
    const previousDeviceId = previousStream.getVideoTracks()[0]?.getSettings().deviceId ?? ""
    const requestedDeviceId = preferredCameraId
    receiverView.patch({ cameraDisabled: true, cameraActual: "Switching camera…" })
    setReceiverPhase("starting")
    capturePipeline.stop()
    pool.resize(0)
    receiverView.patch({ previewVisible: false })
    previousStream.getTracks().forEach((track) => track.stop())
    stream = null
    video.srcObject = null

    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    let nextStream: MediaStream
    let restoredPrevious = false
    try {
      nextStream = await acquireCamera(getUserMedia, cameraSelection(requestedDeviceId), captureWidth, captureFps)
    } catch {
      try {
        nextStream = await acquireCamera(getUserMedia, cameraSelection(previousDeviceId), captureWidth, captureFps)
        restoredPrevious = true
      } catch {
        receiverView.patch({ cameraDisabled: false })
        offerRetry("the camera could not be restarted — choose another camera and try again.")
        return
      }
    }

    if (receiverSession.done) {
      nextStream.getTracks().forEach((track) => track.stop())
      return
    }

    stream = nextStream
    const previewReady = await prepareMediaPreview(video, nextStream)
    if (receiverSession.done || stream !== nextStream) {
      nextStream.getTracks().forEach((track) => track.stop())
      if (video.srcObject === nextStream) video.srcObject = null
      return
    }
    if (!previewReady) {
      nextStream.getTracks().forEach((track) => track.stop())
      stream = null
      if (video.srcObject === nextStream) video.srcObject = null
      receiverView.patch({ cameraDisabled: false })
      offerRetry("the camera restarted, but its preview did not produce a video frame — try again.")
      return
    }
    syncPreviewAspect()
    receiverView.patch({ previewVisible: true })
    pool.resize(workerCount)
    setReceiverPhase(receiverRuntime.snapshot ? "receiving" : "searching")
    capturePipeline.start(stream.getVideoTracks()[0])
    receiverView.patch({ cameraDisabled: false })
    if (restoredPrevious) preferredCameraId = previousDeviceId
    await populateCameraOptions()
    void applyCameraExtras()
    reportReceiverSettings(
      restoredPrevious ? "selected camera unavailable; kept the previous camera" : "changes apply live",
    )
  }

  function applyDecodeWorkerSetting(): void {
    // finish() has already torn the pool down — do not resurrect it.
    if (receiverSession.done) return
    pool.resize(workerCount)
    reportReceiverSettings()
  }

  async function applyCameraSettings(): Promise<void> {
    if (receiverSession.done) return
    const track = stream?.getVideoTracks()[0]
    if (!track) return
    reportReceiverSettings("applying camera settings…")
    try {
      await track.applyConstraints(preferredCameraMode(captureWidth, captureFps))
    } catch {
      // Some devices (notably iOS) refuse a live reconfigure. Keep the stream we
      // have rather than tearing down a transfer in progress.
      if (!receiverSession.done) reportReceiverSettings("camera refused the live change; restart to apply")
      return
    }
    // The transfer may have completed while applyConstraints was pending. Do not
    // recreate capture infrastructure that finish() has already torn down.
    if (receiverSession.done || track !== stream?.getVideoTracks()[0]) return
    // A transferred clone has its own constraints. Recreate the worker source
    // immediately after a camera width/fps change so capture does not wait for
    // the actual-settings UI to settle. Other capture modes consume the original
    // track and update in place.
    capturePipeline.restartWorkerSource(track)
    // Give the camera mode 1 s to settle before displaying the track's actual
    // dimensions and frame rate. This also covers teardown or camera switching
    // during the UI-only settling delay.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000))
    if (receiverSession.done || track !== stream?.getVideoTracks()[0]) return
    reportReceiverSettings()
  }

  async function applyScreenSettings(): Promise<void> {
    if (receiverSession.done || receiverSession.mode !== "screen") return
    const track = stream?.getVideoTracks()[0]
    if (!track) return
    reportReceiverSettings("applying screen FPS…")
    try {
      await track.applyConstraints({ frameRate: { ideal: captureFps } })
    } catch {
      if (!receiverSession.done && receiverSession.mode === "screen")
        reportReceiverSettings("screen capture refused the FPS change")
      return
    }
    if (receiverSession.done || receiverSession.mode !== "screen" || track !== stream?.getVideoTracks()[0]) return
    capturePipeline.restartWorkerSource(track)
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1000))
    if (receiverSession.done || receiverSession.mode !== "screen" || track !== stream?.getVideoTracks()[0]) return
    reportReceiverSettings()
  }

  function stopMediaStream(): void {
    const currentStream = stream
    stream = null
    video.srcObject = null
    currentStream?.getTracks().forEach((track) => track.stop())
  }

  function releaseDecodeWorkers(): void {
    // Disconnect every decode-worker port before terminating the shared
    // fountain worker that owns the other side of those channels.
    pool.resize(0)
    fountainClient.terminate()
  }

  async function stopActiveReceiver(): Promise<void> {
    await Promise.allSettled([
      Promise.resolve().then(() => capturePipeline.stop()),
      Promise.resolve().then(() => abortApngParser()),
      Promise.resolve().then(() => stopMediaStream()),
      Promise.resolve().then(() => stopUpdateTimer()),
      Promise.resolve().then(() => receiverWakeLock.stop()),
    ])
  }

  /** Stop the current input while keeping the expensive WASM-backed decoder
   * workers available for the next multipart stream. */
  async function suspendReceiver(): Promise<void> {
    await stopActiveReceiver()
    // No decode-worker callback may cross resetReceiver(), especially APNG
    // credit acknowledgements. Then drain their side-channel messages so an
    // old stream cannot arrive after the next identity has started.
    await pool.whenIdle()
    await fountainClient.waitForFullDrain()
  }

  /** Full teardown for final results, mode changes, failures and page exit. */
  async function teardownReceiver(): Promise<void> {
    // Fatal worker paths cannot wait for a drain acknowledgement from the
    // failed worker, so full teardown releases immediately after input stops.
    await stopActiveReceiver()
    releaseDecodeWorkers()
  }

  /** Restore the initial receiver UI without navigating away. Multipart
   * receives keep their initialized decoder workers parked between parts. */
  function resetReceiver(): void {
    receivedFileResource.release()
    transferCoordinator.resetProgress()
    receiverSession.reset()
    capturePipeline.reset()

    receiverView.resetTransfer(receiverSession.mode)
    resetPreviewLayout()
    setReceiverPhase("idle")
    reportPendingReceiverSettings()
    updateReceiveModeUi()
    // The multi-part accumulator intentionally survives this reset, so the
    // received/missing summary stays visible across mode switches and parts.
    transferCoordinator.renderPartStatus()
  }

  function updateReceiverState() {
    if (receiverSession.done) return
    transferCoordinator.updateProgress()
  }

  function handlePageHide(event: PageTransitionEvent): void {
    if (event.persisted) {
      // Screen wake locks are released when a document becomes hidden. Stop our
      // acquisition state too, then reacquire when bfcache restores the page.
      void receiverWakeLock.stop()
      return
    }
    receiverSession.invalidate()
    receivedFileResource.release()
    transferCoordinator.resetParts()
    void teardownReceiver()
  }

  function handlePageShow(event: PageTransitionEvent): void {
    if (event.persisted && stream && !receiverSession.done) void receiverWakeLock.start()
  }

  window.addEventListener("pagehide", handlePageHide)
  window.addEventListener("pageshow", handlePageShow)

  function updateCaptureWidth(value: number): void {
    captureWidth = value
    receiverView.patch({ captureWidth: value })
    persistReceiverSettings()
    if (stream && !receiverSession.done && receiverSession.mode === "camera") void applyCameraSettings()
    else if (!receiverSession.done) reportPendingReceiverSettings()
  }

  function updateCaptureFps(value: number): void {
    captureFps = value
    receiverView.patch({ captureFps: value })
    persistReceiverSettings()
    if (stream && !receiverSession.done && receiverSession.mode === "screen") void applyScreenSettings()
    else if (stream && !receiverSession.done && receiverSession.mode === "camera") void applyCameraSettings()
    else if (!receiverSession.done) reportPendingReceiverSettings()
  }

  function updateWorkerCount(value: number): void {
    workerCount = value
    receiverView.patch({ workers: value })
    persistReceiverSettings()
    if (stream && !receiverSession.done) applyDecodeWorkerSetting()
    else if (!receiverSession.done) reportPendingReceiverSettings()
  }

  function updateCamera(value: string): void {
    preferredCameraId = value
    receiverView.patch({ cameraId: value })
    persistReceiverSettings()
    if (stream && !receiverSession.done) void switchCamera()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    video.removeEventListener("resize", syncPreviewAspect)
    video.removeEventListener("resize", reportScreenResize)
    video.removeEventListener("loadedmetadata", syncPreviewAspect)
    window.removeEventListener("resize", syncPreviewAspect)
    window.visualViewport?.removeEventListener("resize", syncPreviewAspect)
    window.removeEventListener("pagehide", handlePageHide)
    window.removeEventListener("pageshow", handlePageShow)
    navigator.mediaDevices?.removeEventListener("devicechange", handleDeviceChange)
    receiverSession.invalidate()
    receivedFileResource.release()
    transferCoordinator.resetParts()
    void teardownReceiver()
  }

  return {
    start: () => void start(),
    switchMode: (mode) => void switchReceiveMode(mode),
    selectApng: (file) => void startApng(file),
    updateCaptureWidth,
    updateCaptureFps,
    updateWorkerCount,
    updateCamera,
    reset: resetReceiver,
    resetParts: () => {
      transferCoordinator.resetParts()
      releaseDecodeWorkers()
      resetReceiver()
    },
    markDownloadStarted: () => receivedFileResource.markDownloadStarted(),
    dispose,
  }
}
