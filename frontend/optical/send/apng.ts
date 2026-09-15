import { asArrayBufferView } from "../../../shared/bytes.js"
import { monochromeStride } from "../shared/monochrome.js"
import {
  apngFrameGeometry,
  OPTICAL_APNG_METADATA_KEYWORD,
  PNG_SIGNATURE,
  validateOpticalApngMetadata,
  type OpticalApngMetadata,
} from "../shared/apng-format.js"
import { zlibSync } from "fflate"

const EMPTY = new Uint8Array(0)
const textEncoder = new TextEncoder()
const CHUNK_TYPES = {
  IHDR: textEncoder.encode("IHDR"),
  PLTE: textEncoder.encode("PLTE"),
  iTXt: textEncoder.encode("iTXt"),
  acTL: textEncoder.encode("acTL"),
  fcTL: textEncoder.encode("fcTL"),
  IDAT: textEncoder.encode("IDAT"),
  fdAT: textEncoder.encode("fdAT"),
  IEND: textEncoder.encode("IEND"),
} as const
type ChunkName = keyof typeof CHUNK_TYPES

// The base QR module scale lives with the other export defaults so the UI can
// offer it without pulling the encoder into the page bundle.
export { APNG_QR_SCALE } from "../shared/fountain.js"

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < table.length; value++) {
    let crc = value
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    table[value] = crc >>> 0
  }
  return table
})()

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let index = 0
  while (index < bytes.length) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
    index++
  }
  return crc
}

function updateCrc32Uint32(crc: number, value: number): number {
  crc = CRC_TABLE[(crc ^ (value >>> 24)) & 0xff] ^ (crc >>> 8)
  crc = CRC_TABLE[(crc ^ (value >>> 16)) & 0xff] ^ (crc >>> 8)
  crc = CRC_TABLE[(crc ^ (value >>> 8)) & 0xff] ^ (crc >>> 8)
  return CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8)
}

function crc32(first: Uint8Array, second: Uint8Array): number {
  return (updateCrc32(updateCrc32(0xffffffff, first), second) ^ 0xffffffff) >>> 0
}

function chunk(name: ChunkName, data: Uint8Array = EMPTY): Uint8Array<ArrayBuffer> {
  const type = CHUNK_TYPES[name]
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(type, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(type, data))
  return out
}

interface DeflatedChunks {
  chunks: Uint8Array<ArrayBuffer>[]
  byteLength: number
}

/** Append one image-data PNG chunk without coalescing or recopying the
 * deflater output. Blob preserves part order when finish() snapshots
 * the completed animation. */
function appendImageDataChunk(
  parts: BlobPart[],
  name: "IDAT" | "fdAT",
  compressed: DeflatedChunks,
  sequence?: number,
): void {
  const hasSequence = name === "fdAT"
  const prefix = new Uint8Array(hasSequence ? 12 : 8)
  const prefixView = new DataView(prefix.buffer)
  prefixView.setUint32(0, compressed.byteLength + (hasSequence ? 4 : 0))
  prefix.set(CHUNK_TYPES[name], 4)

  let crc = updateCrc32(0xffffffff, CHUNK_TYPES[name])
  if (hasSequence) {
    if (sequence === undefined) throw new Error("An fdAT chunk requires a sequence number.")
    prefixView.setUint32(8, sequence)
    crc = updateCrc32Uint32(crc, sequence)
  }
  parts.push(prefix)
  for (const current of compressed.chunks) {
    crc = updateCrc32(crc, current)
    parts.push(current)
  }
  const trailer = new Uint8Array(4)
  new DataView(trailer.buffer).setUint32(0, (crc ^ 0xffffffff) >>> 0)
  parts.push(trailer)
}

function byteStream(bytes: Uint8Array): ReadableStream<BufferSource> {
  const source = asArrayBufferView(bytes)
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(source)
      controller.close()
    },
  })
}

async function deflate(bytes: Uint8Array): Promise<DeflatedChunks> {
  let compressionStream: CompressionStream | undefined
  try {
    compressionStream = new CompressionStream("deflate")
  } catch {
    // APNG export already runs in a short-lived worker. Keep the fallback in
    // that worker and emit the zlib-wrapped DEFLATE stream required by PNG.
    const compressed = zlibSync(bytes, { level: 6 })
    return { chunks: [compressed], byteLength: compressed.length }
  }

  const reader = byteStream(bytes).pipeThrough(compressionStream).getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const buffer = value.buffer
    const owned =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, value.byteOffset, value.byteLength)
        : Uint8Array.from(value)
    chunks.push(owned)
    total += owned.length
  }
  return { chunks, byteLength: total }
}

/** Prefix each packed 1-bit scanline with PNG's None filter byte. */
function filterMonochrome(
  pixels: Uint8Array,
  width: number,
  height: number,
  filtered: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const stride = monochromeStride(width)
  if (pixels.length !== stride * height || filtered.length !== (stride + 1) * height) {
    throw new Error("The APNG frame dimensions do not match its monochrome data.")
  }
  for (let y = 0; y < height; y++) {
    const sourceOffset = y * stride
    const targetOffset = y * (stride + 1)
    filtered[targetOffset] = 0
    filtered.set(pixels.subarray(sourceOffset, sourceOffset + stride), targetOffset + 1)
  }
  return filtered
}

function animationControl(frameCount: number, plays: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(8)
  const view = new DataView(data.buffer)
  view.setUint32(0, frameCount)
  view.setUint32(4, plays)
  return data
}

function imageHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(13)
  const view = new DataView(data.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  data[8] = 1 // bit depth
  data[9] = 3 // indexed / palette
  return data
}

/** Two-entry black/white palette for the 1-bit indexed export. Index 0 is
 * black and index 1 is white, matching the packed monochrome bit order. */
function palette(): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(0x00, 0x00, 0x00, 0xff, 0xff, 0xff)
}

/** Standard uncompressed iTXt metadata. The empty language and translated
 * keyword fields keep the record compact while remaining valid PNG text. */
function opticalQrMetadataText(metadata: OpticalApngMetadata): Uint8Array<ArrayBuffer> {
  const keyword = textEncoder.encode(OPTICAL_APNG_METADATA_KEYWORD)
  const value = textEncoder.encode(JSON.stringify(validateOpticalApngMetadata(metadata)))
  const data = new Uint8Array(keyword.length + 5 + value.length)
  data.set(keyword)
  // keyword terminator, compression flag/method, language terminator and
  // translated-keyword terminator are all zero in the fresh allocation.
  data.set(value, keyword.length + 5)
  return data
}

function frameControl(sequence: number, width: number, height: number, fps: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(26)
  const view = new DataView(data.buffer)
  view.setUint32(0, sequence)
  view.setUint32(4, width)
  view.setUint32(8, height)
  view.setUint16(20, 1) // delay numerator
  view.setUint16(22, fps) // delay denominator
  data[24] = 0 // dispose: none
  data[25] = 0 // blend: source
  return data
}

/** Minimal 1-bit indexed (palette), full-frame APNG encoder with native compression and an fflate fallback. */
export class ApngEncoder {
  private readonly parts: BlobPart[]
  private readonly filteredScratch: Uint8Array<ArrayBuffer>
  private sequence = 0
  private addedFrames = 0
  private addingFrame = false

  constructor(
    readonly width: number,
    readonly height: number,
    readonly frameCount: number,
    readonly fps: number,
    readonly metadata: OpticalApngMetadata,
    plays = 0,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error("APNG dimensions must be positive integers.")
    }
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 0xffffffff) {
      throw new Error("APNG frame count is out of range.")
    }
    if (!Number.isInteger(fps) || fps < 1 || fps > 0xffff) throw new Error("APNG frame rate is out of range.")
    this.metadata = validateOpticalApngMetadata(metadata)
    apngFrameGeometry(width, height, this.metadata)
    this.parts = [
      PNG_SIGNATURE,
      chunk("IHDR", imageHeader(width, height)),
      chunk("PLTE", palette()),
      chunk("iTXt", opticalQrMetadataText(this.metadata)),
      chunk("acTL", animationControl(frameCount, plays)),
    ]
    this.filteredScratch = new Uint8Array((monochromeStride(width) + 1) * height)
  }

  async addFrame(pixels: Uint8Array): Promise<void> {
    if (this.addingFrame) throw new Error("APNG frames must be added sequentially.")
    if (this.addedFrames >= this.frameCount) throw new Error("Too many APNG frames were supplied.")
    this.addingFrame = true
    try {
      const compressed = await deflate(filterMonochrome(pixels, this.width, this.height, this.filteredScratch))
      this.parts.push(chunk("fcTL", frameControl(this.sequence++, this.width, this.height, this.fps)))
      if (this.addedFrames === 0) {
        appendImageDataChunk(this.parts, "IDAT", compressed)
      } else {
        appendImageDataChunk(this.parts, "fdAT", compressed, this.sequence++)
      }
      this.addedFrames += 1
    } finally {
      this.addingFrame = false
    }
  }

  finish(): Blob {
    if (this.addedFrames !== this.frameCount) {
      throw new Error(`APNG expected ${this.frameCount} frames but received ${this.addedFrames}.`)
    }
    return new Blob([...this.parts, chunk("IEND")], { type: "image/png" })
  }
}
