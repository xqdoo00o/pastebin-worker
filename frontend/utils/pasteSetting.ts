import type { PublicEnv } from "../../shared/interfaces.js"
import { PASTE_NAME_LEN, PRIVATE_PASTE_NAME_LEN } from "../../shared/constants.js"
import { parsePath } from "../../shared/parsers.js"
import { verifyReadLimit, verifyReceiverLimit } from "../../shared/verify.js"
import {
  DEFAULT_FRAME_BYTES,
  DEFAULT_TX_FPS,
  FRAME_BYTES_OPTIONS,
  OPTICAL_ECC_OPTIONS,
  OPTICAL_GRID_OPTIONS,
  TX_FPS_OPTIONS,
  normalizeFrameBytesForEcc,
} from "../optical/shared/settings.js"
import type { OpticalTransferSettings } from "../optical/shared/settings.js"
import type { QrErrorCorrection } from "../optical/shared/qr.js"
import { verifyExpiration, verifyManageUrl, verifyP2PExpiration } from "./utils.js"
import type { ArchiveCompression } from "./archiveCore.js"

type OpticalDefaultConfig = Partial<
  Pick<PublicEnv, "DEFAULT_QR_TX_FPS" | "DEFAULT_QR_FRAME_BYTES" | "DEFAULT_QR_ECC" | "DEFAULT_QR_LAYOUT">
>

function configuredNumber(value: unknown, options: readonly number[], fallback: number): number {
  const normalized = typeof value === "number" ? value : Number(value)
  return options.includes(normalized) ? normalized : fallback
}

function configuredEcc(value: unknown): QrErrorCorrection {
  const normalized = typeof value === "string" ? value.toUpperCase() : ""
  return OPTICAL_ECC_OPTIONS.includes(normalized as QrErrorCorrection) ? (normalized as QrErrorCorrection) : "L"
}

export function defaultOpticalTransferSettings(config: OpticalDefaultConfig = {}): OpticalTransferSettings {
  const ecc = configuredEcc(config.DEFAULT_QR_ECC)
  const frameBytes = configuredNumber(config.DEFAULT_QR_FRAME_BYTES, FRAME_BYTES_OPTIONS, DEFAULT_FRAME_BYTES)
  return {
    txFps: configuredNumber(config.DEFAULT_QR_TX_FPS, TX_FPS_OPTIONS, DEFAULT_TX_FPS),
    frameBytes: normalizeFrameBytesForEcc(frameBytes, ecc),
    ecc,
    gridCodes: configuredNumber(
      config.DEFAULT_QR_LAYOUT,
      OPTICAL_GRID_OPTIONS,
      1,
    ) as OpticalTransferSettings["gridCodes"],
  }
}

export type LinkType = "short" | "long"
export type UploadKind = LinkType | "manage"
const TRANSFER_METHODS = ["upload", "p2p", "optical"] as const
export type TransferMethod = (typeof TRANSFER_METHODS)[number]

export function normalizeLinkType(value: unknown): LinkType {
  return value === "long" ? "long" : "short"
}

export function managedLinkType(manageUrl: string): LinkType | undefined {
  try {
    const { name } = parsePath(new URL(manageUrl).pathname)
    if (name.length === PASTE_NAME_LEN) return "short"
    if (name.length === PRIVATE_PASTE_NAME_LEN) return "long"
  } catch {
    // Invalid management URLs have no selected link type and fail validation separately.
  }
  return undefined
}

export function normalizeTransferMethod(value: unknown): TransferMethod {
  return typeof value === "string" && TRANSFER_METHODS.includes(value as TransferMethod)
    ? (value as TransferMethod)
    : "upload"
}

export type { ArchiveCompression } from "./archiveCore.js"

export function normalizeArchiveCompression(value: unknown): ArchiveCompression {
  return value === "zstd" ? "zstd" : "deflate"
}

export interface PasteSetting {
  uploadKind: UploadKind
  transferMethod: TransferMethod
  archiveCompression: ArchiveCompression
  /** Package a single ordinary file as a ZIP for upload/P2P transfer. */
  compressSingleFile?: boolean
  expiration: string
  readLimit: string
  manageUrl: string
  doEncrypt: boolean
  verifyP2P: boolean
  optical: OpticalTransferSettings
}

export function createInitialPasteSetting(
  config: PublicEnv,
  optical: OpticalTransferSettings = defaultOpticalTransferSettings(config),
): PasteSetting {
  const transferMethod = normalizeTransferMethod(config.DEFAULT_TRANSFER_METHOD)
  return {
    expiration: transferMethod === "p2p" ? config.DEFAULT_P2P_EXPIRATION : config.DEFAULT_EXPIRATION,
    readLimit: String(transferMethod === "p2p" ? config.DEFAULT_P2P_TRANSFERS : config.DEFAULT_READS),
    manageUrl: "",
    uploadKind: normalizeLinkType(config.DEFAULT_LINK_TYPE),
    transferMethod,
    archiveCompression:
      transferMethod === "optical" ? "zstd" : normalizeArchiveCompression(config.DEFAULT_ARCHIVE_COMPRESSION),
    compressSingleFile: false,
    doEncrypt: transferMethod === "upload" && config.DEFAULT_E2E_ENCRYPTION,
    verifyP2P: transferMethod === "p2p" && config.DEFAULT_P2P_VERIFY,
    optical,
  }
}

export type ValidationResult = [boolean, string]

export interface PasteSettingValidation {
  expiration: ValidationResult
  readLimit: ValidationResult
  manageUrl: ValidationResult
  isValid: boolean
}

const VALID: ValidationResult = [true, ""]

export function validatePasteSetting(setting: PasteSetting, config: PublicEnv): PasteSettingValidation {
  const isP2P = setting.transferMethod === "p2p"
  const isOptical = setting.transferMethod === "optical"
  const expiration = isOptical
    ? VALID
    : isP2P
      ? verifyP2PExpiration(setting.expiration, config)
      : verifyExpiration(setting.expiration, config)
  const readLimit = isOptical
    ? VALID
    : isP2P
      ? verifyReceiverLimit(setting.readLimit)
      : verifyReadLimit(setting.readLimit)
  const isUpload = setting.transferMethod === "upload"
  const manageUrl = isUpload && setting.uploadKind === "manage" ? verifyManageUrl(setting.manageUrl, config) : VALID
  const results = [expiration, readLimit, manageUrl]

  return {
    expiration,
    readLimit,
    manageUrl,
    isValid: results.every(([valid]) => valid),
  }
}

export function switchPasteTransferMethod(
  setting: PasteSetting,
  transferMethod: TransferMethod,
  config: PublicEnv,
): PasteSetting {
  if (transferMethod === setting.transferMethod) return setting

  const isNextP2P = transferMethod === "p2p"
  const isNextOptical = transferMethod === "optical"
  const [isNextExpirationValid] = validatePasteSetting({ ...setting, transferMethod }, config).expiration
  return {
    ...setting,
    transferMethod,
    uploadKind:
      isNextP2P && setting.uploadKind === "manage" ? normalizeLinkType(config.DEFAULT_LINK_TYPE) : setting.uploadKind,
    archiveCompression: isNextOptical
      ? "zstd"
      : setting.transferMethod === "optical"
        ? normalizeArchiveCompression(config.DEFAULT_ARCHIVE_COMPRESSION)
        : setting.archiveCompression,
    expiration: isNextP2P
      ? isNextExpirationValid
        ? setting.expiration
        : config.DEFAULT_P2P_EXPIRATION
      : transferMethod === "upload"
        ? config.DEFAULT_EXPIRATION
        : setting.expiration,
    readLimit: String(isNextP2P ? config.DEFAULT_P2P_TRANSFERS : config.DEFAULT_READS),
    doEncrypt: transferMethod === "upload" ? config.DEFAULT_E2E_ENCRYPTION : false,
    verifyP2P: isNextP2P ? config.DEFAULT_P2P_VERIFY : false,
  }
}
