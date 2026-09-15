import { gridDims, TRANSFER_QR_MARGIN } from "./qr.js"

export const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)

export const OPTICAL_APNG_FORMAT_VERSION = 1
export const OPTICAL_APNG_METADATA_KEYWORD = "qr-transfer"
const OPTICAL_APNG_GRID_CODES = [1, 2, 4, 6, 9] as const

export interface OpticalApngMetadata {
  format: typeof OPTICAL_APNG_FORMAT_VERSION
  /** Physical PNG pixels per QR module. */
  scale: number
  /** Number of QR symbols in the complete rectangular grid. */
  grid: number
  /** ISO/IEC 18004 QR version shared by every symbol. */
  qr: number
}

export interface ApngFrameGeometry {
  outputWidth: number
  outputHeight: number
  packedLength: number
  modules: number
  cellSize: number
  columns: number
  rows: number
}

export function validateOpticalApngMetadata(value: unknown): OpticalApngMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The APNG QR metadata is invalid.")
  }
  const metadata = value as Partial<OpticalApngMetadata>
  if (
    metadata.format !== OPTICAL_APNG_FORMAT_VERSION ||
    !Number.isInteger(metadata.scale) ||
    metadata.scale! < 1 ||
    metadata.scale! > 4 ||
    !OPTICAL_APNG_GRID_CODES.includes(metadata.grid as (typeof OPTICAL_APNG_GRID_CODES)[number]) ||
    !Number.isInteger(metadata.qr) ||
    metadata.qr! < 1 ||
    metadata.qr! > 40
  ) {
    throw new Error("The APNG QR metadata is invalid.")
  }
  return {
    format: OPTICAL_APNG_FORMAT_VERSION,
    scale: metadata.scale!,
    grid: metadata.grid!,
    qr: metadata.qr!,
  }
}

export function apngFrameGeometry(
  width: number,
  height: number,
  metadataValue: OpticalApngMetadata,
): ApngFrameGeometry {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("The APNG frame dimensions are invalid.")
  }
  const metadata = validateOpticalApngMetadata(metadataValue)
  const { cols: columns, rows } = gridDims(metadata.grid)
  const modules = 17 + 4 * metadata.qr
  const cellSize = modules + 2 * TRANSFER_QR_MARGIN
  const outputWidth = cellSize * columns
  const outputHeight = cellSize * rows
  if (width !== outputWidth * metadata.scale || height !== outputHeight * metadata.scale) {
    throw new Error("The APNG QR metadata does not match its dimensions.")
  }
  const packedLength = Math.ceil(outputWidth / 8) * outputHeight
  if (!Number.isSafeInteger(packedLength)) throw new Error("The APNG frame dimensions are too large.")
  return { outputWidth, outputHeight, packedLength, modules, cellSize, columns, rows }
}
