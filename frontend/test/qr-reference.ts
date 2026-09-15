import { correction, generate, mode, type Correction } from "lean-qr"
import type { QrBitmap, QrErrorCorrection } from "../optical/shared/qr.js"

const CORRECTION_LEVELS: Readonly<Record<QrErrorCorrection, Correction>> = {
  L: correction.L,
  M: correction.M,
  Q: correction.Q,
  H: correction.H,
}

export interface ReferenceQrBitmap extends QrBitmap {
  get(x: number, y: number): boolean
}

/** Independent test-only QR generator used to check NanoRQ's Nayuki output. */
export function referenceTransferQr(bytes: Uint8Array, ecc: QrErrorCorrection, version?: number): ReferenceQrBitmap {
  const generated = generate(mode.bytes(bytes), {
    minCorrectionLevel: CORRECTION_LEVELS[ecc],
    maxCorrectionLevel: CORRECTION_LEVELS[ecc],
    minVersion: version,
    maxVersion: version,
    mask: 3,
  })
  return patternedQr(generated.size, (x, y) => generated.get(x, y))
}

export function patternedQr(size: number, get: (x: number, y: number) => boolean): ReferenceQrBitmap {
  const packed = new Uint8Array(Math.ceil((size * size) / 8))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x
      if (get(x, y)) packed[index >> 3] |= 1 << (index & 7)
    }
  }
  return { size, packed, get }
}
