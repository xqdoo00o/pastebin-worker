import { qrPackedMatrix, type QrBitmap } from "./qr.js"

export interface MonochromeImage {
  width: number
  height: number
  data: Uint8Array<ArrayBuffer>
}

export function monochromeStride(width: number): number {
  if (!Number.isInteger(width) || width < 1) throw new Error("Monochrome width must be a positive integer.")
  return Math.ceil(width / 8)
}

export function monochromeByteLength(width: number, height: number): number {
  if (!Number.isInteger(height) || height < 1) throw new Error("Monochrome height must be a positive integer.")
  return monochromeStride(width) * height
}

/** Allocate a white 1-bit image (bit 0 is black, bit 1 is white). */
export function createMonochromeFrame(width: number, height: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(monochromeByteLength(width, height))
  frame.fill(0xff)
  return frame
}

export function createMonochromeRgbaLookup(black: number, white: number): Uint32Array<ArrayBuffer> {
  const lookup = new Uint32Array(256 * 8)
  for (let byte = 0; byte < 256; byte++) {
    const offset = byte * 8
    for (let bit = 0; bit < 8; bit++) lookup[offset + bit] = byte & (0x80 >> bit) ? white : black
  }
  return lookup
}

function clearBlackMask(target: Uint8Array, offset: number, bitOffset: number, blackMask: number): void {
  target[offset] &= ~(blackMask >>> bitOffset)
  if (bitOffset !== 0) target[offset + 1] &= ~(blackMask << (8 - bitOffset))
}

/** Set an arbitrary horizontal span to white without touching adjacent bits. */
function setWhiteRun(target: Uint8Array, rowOffset: number, x: number, length: number): void {
  const end = x + length
  if (x >> 3 === (end - 1) >> 3) {
    const bitOffset = x & 7
    const mask = (0xff >>> bitOffset) & (0xff << (8 - bitOffset - length))
    target[rowOffset + (x >> 3)] |= mask
    return
  }
  let byte = x >> 3
  const firstBit = x & 7
  if (firstBit !== 0) {
    target[rowOffset + byte++] |= 0xff >>> firstBit
  }
  const wholeByteEnd = end >> 3
  target.fill(0xff, rowOffset + byte, rowOffset + wholeByteEnd)
  const lastBits = end & 7
  if (lastBits !== 0) target[rowOffset + wholeByteEnd] |= (0xff << (8 - lastBits)) & 0xff
}

/** Set an arbitrary horizontal span to black without touching adjacent bits. */
function setBlackRun(target: Uint8Array, rowOffset: number, x: number, length: number): void {
  const end = x + length
  if (x >> 3 === (end - 1) >> 3) {
    const bitOffset = x & 7
    const mask = (0xff >>> bitOffset) & (0xff << (8 - bitOffset - length))
    target[rowOffset + (x >> 3)] &= ~mask
    return
  }
  let byte = x >> 3
  const firstBit = x & 7
  if (firstBit !== 0) {
    target[rowOffset + byte++] &= ~(0xff >>> firstBit)
  }
  const wholeByteEnd = end >> 3
  target.fill(0, rowOffset + byte, rowOffset + wholeByteEnd)
  const lastBits = end & 7
  if (lastBits !== 0) target[rowOffset + wholeByteEnd] &= ~((0xff << (8 - lastBits)) & 0xff)
}

const REVERSED_BITS = Uint8Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  value = ((value & 0xaa) >>> 1) | ((value & 0x55) << 1)
  value = ((value & 0xcc) >>> 2) | ((value & 0x33) << 2)
  return ((value & 0xf0) >>> 4) | ((value & 0x0f) << 4)
})

/** Read eight consecutive Nayuki LSB-first module bits and return them with
 * the first module in bit 7, matching the monochrome renderer's bit order. */
function packedQrBlackMask(packed: Uint8Array, bitOffset: number): number {
  const byteOffset = bitOffset >> 3
  const shift = bitOffset & 7
  const value =
    shift === 0 ? packed[byteOffset] : (packed[byteOffset] >>> shift) | ((packed[byteOffset + 1] ?? 0) << (8 - shift))
  return REVERSED_BITS[value & 0xff]
}

/** Pack one unscaled QR cell, including its white quiet-zone margin. */
export function qrMonochrome(qr: QrBitmap, margin: number, reusable?: Uint8Array<ArrayBuffer>): MonochromeImage {
  if (!Number.isInteger(margin) || margin < 0) throw new Error("QR margin must be a non-negative integer.")
  const width = qr.size + 2 * margin
  const height = width
  const stride = monochromeStride(width)
  const expectedBytes = stride * height
  const data = reusable?.length === expectedBytes ? reusable : new Uint8Array(expectedBytes)
  data.fill(0xff)
  const packed = qrPackedMatrix(qr)
  for (let y = 0; y < qr.size; y++) {
    const sourceRow = y * qr.size
    const targetRow = (y + margin) * stride
    let x = 0
    for (; x + 8 <= qr.size; x += 8) {
      const source = sourceRow + x
      const blackMask = packedQrBlackMask(packed, source)
      const targetX = x + margin
      clearBlackMask(data, targetRow + (targetX >> 3), targetX & 7, blackMask)
    }
    const remaining = qr.size - x
    const blackMask = remaining > 0 ? packedQrBlackMask(packed, sourceRow + x) & (0xff << (8 - remaining)) : 0
    if (x < qr.size) {
      const targetX = x + margin
      clearBlackMask(data, targetRow + (targetX >> 3), targetX & 7, blackMask)
    }
  }
  return { width, height, data }
}

/** Expand packed pixels into an existing native-endian RGBA32 scratch buffer. */
export function expandMonochromeRgba(
  source: Uint8Array,
  width: number,
  height: number,
  target: Uint32Array,
  lookup: Uint32Array,
): void {
  if (target.length !== width * height) {
    throw new Error("The monochrome and RGBA image dimensions do not match.")
  }
  expandMonochromeRgbaRegion(source, width, height, target, width, 0, 0, lookup)
}

/** Expand packed pixels into a rectangular region of an RGBA32 target. */
export function expandMonochromeRgbaRegion(
  source: Uint8Array,
  width: number,
  height: number,
  target: Uint32Array,
  targetWidth: number,
  targetX: number,
  targetY: number,
  lookup: Uint32Array,
): void {
  const stride = monochromeStride(width)
  const targetHeight = target.length / targetWidth
  if (
    source.length !== stride * height ||
    !Number.isInteger(targetWidth) ||
    targetWidth < 1 ||
    !Number.isInteger(targetHeight) ||
    !Number.isInteger(targetX) ||
    targetX < 0 ||
    targetX + width > targetWidth ||
    !Number.isInteger(targetY) ||
    targetY < 0 ||
    targetY + height > targetHeight ||
    lookup.length !== 256 * 8
  ) {
    throw new Error("The monochrome and RGBA image dimensions do not match.")
  }
  const fullBytes = width >> 3
  const remainingPixels = width & 7
  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride
    let targetOffset = (targetY + y) * targetWidth + targetX
    for (let byte = 0; byte < fullBytes; byte++) {
      const lookupOffset = source[rowOffset + byte] << 3
      target[targetOffset++] = lookup[lookupOffset]
      target[targetOffset++] = lookup[lookupOffset + 1]
      target[targetOffset++] = lookup[lookupOffset + 2]
      target[targetOffset++] = lookup[lookupOffset + 3]
      target[targetOffset++] = lookup[lookupOffset + 4]
      target[targetOffset++] = lookup[lookupOffset + 5]
      target[targetOffset++] = lookup[lookupOffset + 6]
      target[targetOffset++] = lookup[lookupOffset + 7]
    }
    if (remainingPixels !== 0) {
      const lookupOffset = source[rowOffset + fullBytes] << 3
      for (let pixel = 0; pixel < remainingPixels; pixel++) target[targetOffset++] = lookup[lookupOffset + pixel]
    }
  }
}

/** Paint a QR symbol directly into a packed 1-bit target with exact integer scaling.
 * The cell is cleared by byte runs, then only contiguous black module runs are
 * expanded. This preserves overwrite semantics without scale² pixel writes. */
export function copyQrMonochrome(
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  qr: QrBitmap,
  margin: number,
  targetX: number,
  targetY: number,
  scale: number,
): void {
  if (!Number.isInteger(scale) || scale < 1) throw new Error("Monochrome scale must be a positive integer.")
  if (!Number.isInteger(margin) || margin < 0) throw new Error("QR margin must be a non-negative integer.")
  const sourceSize = qr.size + 2 * margin
  const stride = monochromeStride(targetWidth)
  const packed = qrPackedMatrix(qr)
  if (
    target.length !== stride * targetHeight ||
    targetX < 0 ||
    targetY < 0 ||
    targetX + sourceSize * scale > targetWidth ||
    targetY + sourceSize * scale > targetHeight
  ) {
    throw new Error("The scaled QR image does not fit in its target frame.")
  }

  const scaledSize = sourceSize * scale
  for (let y = targetY; y < targetY + scaledSize; y++) setWhiteRun(target, y * stride, targetX, scaledSize)

  for (let qrY = 0; qrY < qr.size; qrY++) {
    const sourceRow = qrY * qr.size
    let runStart = -1
    for (let qrX = 0; qrX <= qr.size; qrX++) {
      const sourceIndex = sourceRow + qrX
      const black = qrX < qr.size && Boolean(packed[sourceIndex >> 3] & (1 << (sourceIndex & 7)))
      if (black && runStart < 0) {
        runStart = qrX
      } else if (!black && runStart >= 0) {
        const x = targetX + (margin + runStart) * scale
        const length = (qrX - runStart) * scale
        const y = targetY + (margin + qrY) * scale
        for (let repeatY = 0; repeatY < scale; repeatY++) setBlackRun(target, (y + repeatY) * stride, x, length)
        runStart = -1
      }
    }
  }
}
