export type QrErrorCorrection = "L" | "M" | "Q" | "H"

export interface QrBitmap {
  readonly size: number
  /** Nayuki-format, linear LSB-first 1-bit-per-module representation. */
  readonly packed: Uint8Array
}

export const TRANSFER_QR_MARGIN = 4

export function qrPackedMatrix(qr: QrBitmap): Uint8Array {
  const packed = qr.packed
  if (!(packed instanceof Uint8Array) || packed.length !== Math.ceil((qr.size * qr.size) / 8)) {
    throw new Error("QR packed matrix dimensions do not match its module width.")
  }
  return packed
}

/** Recover the ISO version number from a symbol's module width. */
export function qrVersion(qr: Pick<QrBitmap, "size">): number {
  const version = (qr.size - 17) / 4
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new Error(`Invalid QR module width: ${qr.size}`)
  }
  return version
}

/** Grid shape for a code count: as square as possible, taller before wider. */
export function gridDims(count: number): { cols: number; rows: number } {
  const cols = Math.floor(Math.sqrt(count))
  const rows = Math.ceil(count / Math.max(1, cols))
  if (count < 1 || cols * rows !== count) {
    throw new Error(`grid needs a count that fills its rows (1, 2, 4, 6, 9…), got ${count}`)
  }
  return { cols, rows }
}
