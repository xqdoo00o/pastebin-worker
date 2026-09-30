import type { QrErrorCorrection } from "./qr.js"
import { browserStorage, readStorageJson, writeStorageJson } from "../../utils/browserStorage.js"

// Sender tuning and persistence live together so every entry normalizes the
// same supported values before they reach the QR encoder.
export const DEFAULT_TX_FPS = 60
export const DEFAULT_FRAME_BYTES = 2953
export const CAPTURE_WIDTH_OPTIONS = [960, 1280, 1600, 1920, 2560, 3840] as const
export const CAPTURE_FPS_OPTIONS = [30, 60] as const
export interface NumericRange {
  min: number
  max: number
  step: number
}

export const DEFAULT_CAMERA_ISO_RANGE: NumericRange = { min: 100, max: 2000, step: 100 }
export const DEFAULT_CAMERA_ISO = 1500

/** Clamp a numeric camera setting to its supported range and nearest step. */
export function clampToStep(value: number, range: NumericRange): number {
  const bounded = Math.min(range.max, Math.max(range.min, value))
  if (bounded === range.max) return range.max
  const stepped = range.min + Math.round((bounded - range.min) / range.step) * range.step
  return Math.min(range.max, Math.max(range.min, Number(stepped.toFixed(6))))
}

export const TX_FPS_OPTIONS: readonly number[] = [10, 15, 20, 24, 30, 50, DEFAULT_TX_FPS, 90, 120]
export const FRAME_BYTES_OPTIONS: readonly number[] = [500, 1000, 1450, 1850, 2331, DEFAULT_FRAME_BYTES, 4143]
export const OPTICAL_ECC_OPTIONS: readonly QrErrorCorrection[] = ["L", "M", "Q", "H"]
export const OPTICAL_GRID_OPTIONS = [1, 2, 4, 6, 9] as const

export type OpticalGridCodes = (typeof OPTICAL_GRID_OPTIONS)[number]

export interface OpticalTransferSettings {
  txFps: number
  frameBytes: number
  ecc: QrErrorCorrection
  gridCodes: OpticalGridCodes
}

export const OPTICAL_GRID_LABELS: Readonly<Record<OpticalGridCodes, string>> = {
  1: "1 code",
  2: "2 codes (1×2)",
  4: "4 codes (2×2)",
  6: "6 codes (2×3)",
  9: "9 codes (3×3)",
}

const FRAME_BYTES_BY_ECC = {
  L: FRAME_BYTES_OPTIONS.filter((bytes) => bytes <= 4143),
  M: FRAME_BYTES_OPTIONS.filter((bytes) => bytes <= 2953),
  Q: FRAME_BYTES_OPTIONS.filter((bytes) => bytes <= 2331),
  H: FRAME_BYTES_OPTIONS.filter((bytes) => bytes <= 1450),
} satisfies Record<QrErrorCorrection, readonly number[]>

export function frameBytesOptionsForEcc(ecc: QrErrorCorrection): readonly number[] {
  return FRAME_BYTES_BY_ECC[ecc]
}

/** Keep the current size when possible; otherwise choose the fastest offered
 * size that the selected ECC can encode. */
export function normalizeFrameBytesForEcc(frameBytes: number, ecc: QrErrorCorrection): number {
  const options = frameBytesOptionsForEcc(ecc)
  return options.includes(frameBytes) ? frameBytes : options[options.length - 1]
}

export const OPTICAL_SENDER_SETTINGS_KEY = "pastebin-worker:qr-sender-settings"
export const OPTICAL_RECEIVER_SETTINGS_KEY = "pastebin-worker:qr-receiver-settings"

const SETTINGS_VERSION = 1

type SettingsStorage = Pick<Storage, "getItem" | "setItem">

export interface OpticalReceiverSettings {
  cameraId: string
  captureWidth: number
  captureFps: number
  iso: number
  workers: number
}

interface OpticalReceiverSettingOptions {
  captureWidths: readonly number[]
  captureFps: readonly number[]
  workers: readonly number[]
}

function storedRecord(key: string, storage: SettingsStorage | undefined): Record<string, unknown> | undefined {
  return readStorageJson(storage, key, (parsed) => {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return record.version === SETTINGS_VERSION ? record : undefined
  })
}

function storedOption<T>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback
}

function storedPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function saveRecord(key: string, settings: object, storage: SettingsStorage | undefined): void {
  writeStorageJson(storage, key, { version: SETTINGS_VERSION, ...settings })
}

/** Restore saved sender tuning on top of the deployment's Wrangler defaults. */
export function loadOpticalSenderSettings(
  defaults: OpticalTransferSettings,
  storage: SettingsStorage | undefined = browserStorage("local"),
): OpticalTransferSettings {
  const saved = storedRecord(OPTICAL_SENDER_SETTINGS_KEY, storage)
  if (!saved) return { ...defaults }
  const ecc = storedOption(saved.ecc, OPTICAL_ECC_OPTIONS, defaults.ecc)
  const frameBytes = storedOption(saved.frameBytes, FRAME_BYTES_OPTIONS, defaults.frameBytes)
  return {
    txFps: storedOption(saved.txFps, TX_FPS_OPTIONS, defaults.txFps),
    frameBytes: normalizeFrameBytesForEcc(frameBytes, ecc),
    ecc,
    gridCodes: storedOption(saved.gridCodes, OPTICAL_GRID_OPTIONS, defaults.gridCodes),
  }
}

export function saveOpticalSenderSettings(
  settings: OpticalTransferSettings,
  storage: SettingsStorage | undefined = browserStorage("local"),
): void {
  saveRecord(OPTICAL_SENDER_SETTINGS_KEY, settings, storage)
}

/** Restore receiver tuning, accepting only values still offered by this device/page. */
export function loadOpticalReceiverSettings(
  defaults: OpticalReceiverSettings,
  options: OpticalReceiverSettingOptions,
  storage: SettingsStorage | undefined = browserStorage("local"),
): OpticalReceiverSettings {
  const saved = storedRecord(OPTICAL_RECEIVER_SETTINGS_KEY, storage)
  if (!saved) return { ...defaults }
  return {
    cameraId: typeof saved.cameraId === "string" && saved.cameraId.length <= 1024 ? saved.cameraId : defaults.cameraId,
    captureWidth: storedOption(saved.captureWidth, options.captureWidths, defaults.captureWidth),
    captureFps: storedOption(saved.captureFps, options.captureFps, defaults.captureFps),
    iso: storedPositiveNumber(saved.iso, defaults.iso),
    workers: storedOption(saved.workers, options.workers, defaults.workers),
  }
}

export function saveOpticalReceiverSettings(
  settings: OpticalReceiverSettings,
  storage: SettingsStorage | undefined = browserStorage("local"),
): void {
  saveRecord(OPTICAL_RECEIVER_SETTINGS_KEY, settings, storage)
}
