import type { OpticalFile } from "../shared/protocol.js"

export type ReceiveMode = "camera" | "screen" | "apng"

export interface ReceiverCameraOption {
  label: string
  value: string
}

export interface ReceiverProgressState {
  visible: boolean
  percent: number
  label: string
  eta: string
  error: boolean
}

export type ReceiverResultState =
  | { kind: "failure" }
  | {
      kind: "file"
      file: OpticalFile | File
      containerBytes: number
      seconds: number
      wasCompressed?: boolean
      stored: boolean
    }

export interface ReceiverUiState {
  mode: ReceiveMode
  status: string
  statusError: boolean
  startVisible: boolean
  startDisabled: boolean
  startLabel: string
  modeButtonsDisabled: boolean
  apngInputDisabled: boolean
  previewVisible: boolean
  introVisible: boolean
  settingsVisible: boolean
  cameraActual: string
  cameraOptions: readonly ReceiverCameraOption[]
  cameraId: string
  cameraDisabled: boolean
  captureWidth: number
  captureFps: number
  workers: number
  disabledCaptureWidths: readonly number[]
  disabledCaptureFps: readonly number[]
  progress: ReceiverProgressState
  partProgress?: { received: number; total: number; missing: readonly number[] }
  result?: ReceiverResultState
  fileInputGeneration: number
}

export const initialReceiverUiState: ReceiverUiState = {
  mode: "camera",
  status: "Ready to receive from camera",
  statusError: false,
  startVisible: true,
  startDisabled: false,
  startLabel: "Start camera",
  modeButtonsDisabled: false,
  apngInputDisabled: false,
  previewVisible: false,
  introVisible: true,
  settingsVisible: true,
  cameraActual: "Applied when the camera starts.",
  cameraOptions: [{ label: "Auto (rear camera)", value: "" }],
  cameraId: "",
  cameraDisabled: true,
  captureWidth: 1280,
  captureFps: 60,
  workers: 1,
  disabledCaptureWidths: [],
  disabledCaptureFps: [],
  progress: {
    visible: false,
    percent: 0,
    label: "0%",
    eta: "Estimating time…",
    error: false,
  },
  fileInputGeneration: 0,
}

/** Multipart actions are offered between parts, then hidden as soon as the
 * selected receive method begins processing the next one. */
export function showMultipartActions(state: ReceiverUiState): boolean {
  if (!state.partProgress) return false
  return state.mode === "apng" ? !state.apngInputDisabled : state.startVisible && !state.startDisabled
}

type StateUpdater = (state: ReceiverUiState) => ReceiverUiState

/** A tiny state bridge between the media/decoder controller and React. */
export class ReceiverView {
  constructor(private readonly update: (updater: StateUpdater) => void) {}

  patch(patch: Partial<ReceiverUiState>): void {
    this.update((state) => ({ ...state, ...patch }))
  }

  patchProgress(patch: Partial<ReceiverProgressState>): void {
    this.update((state) => ({ ...state, progress: { ...state.progress, ...patch } }))
  }

  showStatus(status: string): void {
    this.patch({ status, statusError: false })
  }

  showError(message: string): void {
    this.patch({ status: `✗ ${message}`, statusError: true })
  }

  updateMode(mode: ReceiveMode): void {
    this.patch({
      mode,
      startVisible: mode !== "apng",
      startLabel: mode === "screen" ? "Start screen capture" : "Start camera",
    })
  }

  offerRetry(mode: ReceiveMode, message: string): void {
    this.patch({
      mode,
      startVisible: mode !== "apng",
      startDisabled: false,
      startLabel: mode === "screen" ? "Start screen capture" : "Start camera",
      modeButtonsDisabled: false,
      apngInputDisabled: false,
      previewVisible: false,
    })
    this.showError(message)
  }

  resetTransfer(mode: ReceiveMode): void {
    this.update((state) => ({
      ...state,
      mode,
      startVisible: mode !== "apng",
      startDisabled: false,
      startLabel: mode === "screen" ? "Start screen capture" : "Start camera",
      modeButtonsDisabled: false,
      apngInputDisabled: false,
      previewVisible: false,
      introVisible: true,
      settingsVisible: true,
      result: undefined,
      fileInputGeneration: state.fileInputGeneration + 1,
      progress: {
        visible: false,
        percent: 0,
        label: "0%",
        eta: "Estimating time…",
        error: false,
      },
    }))
  }
}
