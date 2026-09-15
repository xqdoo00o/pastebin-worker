/** Streaming parser for the deliberately small APNG format produced by the
 * optical sender. Hosted pages retain immutable Blob slices; standalone pages
 * use transferred bytes throughout so Safari never reads a blob:null URL. */

import {
  apngFrameGeometry,
  OPTICAL_APNG_METADATA_KEYWORD,
  PNG_SIGNATURE,
  validateOpticalApngMetadata,
  type OpticalApngMetadata,
} from "../shared/apng-format.js"
const MAX_DIMENSION = 16_384
const MAX_FRAMES = 100_000
const IHDR = 0x4948_4452
const PLTE = 0x504c_5445
const ITXT = 0x6954_5874
const ACTL = 0x6163_544c
const FCTL = 0x6663_544c
const IDAT = 0x4944_4154
const FDAT = 0x6664_4154
const IEND = 0x4945_4e44
/** The sender always exports a fixed two-entry black/white palette: index 0
 * black, index 1 white. Verify it so a mismatched render cannot silently swap
 * the two colors. */
const EXPECTED_PALETTE = Uint8Array.of(0x00, 0x00, 0x00, 0xff, 0xff, 0xff)
const textDecoder = new TextDecoder()

export interface CompressedApngFrame {
  compressed: Blob | Uint8Array<ArrayBuffer>
  width: number
  height: number
  metadata: OpticalApngMetadata
  index: number
  total: number
}

export interface ApngInfo {
  width: number
  height: number
  frames: number
  metadata: OpticalApngMetadata
}

function isExpectedPalette(data: Uint8Array): boolean {
  if (data.length !== EXPECTED_PALETTE.length) return false
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== EXPECTED_PALETTE[index]) return false
  }
  return true
}

/** null means an unrelated iTXt keyword; undefined means a malformed optical
 * metadata record. The record is deliberately atomic so scale, layout and QR
 * version cannot be accepted from mutually inconsistent chunks. */
function parseOpticalQrMetadataText(data: Uint8Array): OpticalApngMetadata | null | undefined {
  const keywordEnd = data.indexOf(0)
  if (keywordEnd < 0) return null
  if (textDecoder.decode(data.subarray(0, keywordEnd)) !== OPTICAL_APNG_METADATA_KEYWORD) return null
  const textStart = keywordEnd + 5
  if (
    textStart > data.length ||
    data[keywordEnd + 1] !== 0 ||
    data[keywordEnd + 2] !== 0 ||
    data[keywordEnd + 3] !== 0 ||
    data[keywordEnd + 4] !== 0
  ) {
    return undefined
  }
  try {
    return validateOpticalApngMetadata(JSON.parse(textDecoder.decode(data.subarray(textStart))))
  } catch {
    return undefined
  }
}

type ApngSource = Blob | Uint8Array<ArrayBuffer>
type ApngPart = Blob | Uint8Array<ArrayBuffer>

function sourceSize(source: ApngSource): number {
  return source instanceof Blob ? source.size : source.byteLength
}

async function readExact(file: ApngSource, start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const end = start + length
  if (!Number.isSafeInteger(end) || start < 0 || length < 0 || end > sourceSize(file)) {
    throw new Error("The APNG file is truncated.")
  }
  const bytes =
    file instanceof Blob ? new Uint8Array(await file.slice(start, end).arrayBuffer()) : file.subarray(start, end)
  if (bytes.length !== length) throw new Error("The APNG file is truncated.")
  return bytes
}

function sourceSlice(file: ApngSource, start: number, end: number): ApngPart {
  return file instanceof Blob ? file.slice(start, end) : file.subarray(start, end)
}

function joinFrameParts(parts: ApngPart[]): Blob | Uint8Array<ArrayBuffer> {
  if (parts.every((part): part is Blob => part instanceof Blob)) return new Blob(parts, { type: "application/zlib" })
  const byteParts = parts as Uint8Array<ArrayBuffer>[]
  const size = byteParts.reduce((total, part) => total + part.byteLength, 0)
  const joined = new Uint8Array(size)
  let offset = 0
  for (const part of byteParts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

function hasSignature(bytes: Uint8Array): boolean {
  return bytes.length === PNG_SIGNATURE.length && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

function compressedStream(compressed: Blob | Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  if (compressed instanceof Uint8Array) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(compressed)
        controller.close()
      },
    })
  }
  const blob = compressed
  const streamable = blob as Blob & { stream?: () => ReadableStream<Uint8Array<ArrayBuffer>> }
  if (typeof streamable.stream === "function") return streamable.stream()
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      if (offset >= blob.size) {
        controller.close()
        return
      }
      const end = Math.min(blob.size, offset + 64 * 1024)
      controller.enqueue(new Uint8Array(await blob.slice(offset, end).arrayBuffer()))
      offset = end
    },
  })
}

/** Inflate one sender-produced PNG frame into caller-owned packed monochrome
 * storage. In production `target` is a view over the decode worker's WASM
 * allocation, so no byte-per-pixel JS image or second transfer is created. */
export async function inflateApngFrameInto(
  compressed: Blob | Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  target: Uint8Array,
  metadata: OpticalApngMetadata,
): Promise<void> {
  const { outputWidth, packedLength } = apngFrameGeometry(width, height, metadata)
  const scale = metadata.scale
  const packedStride = Math.ceil(width / 8)
  const outputStride = Math.ceil(outputWidth / 8)
  if (target.length !== packedLength) {
    throw new Error("The APNG frame dimensions are too large.")
  }
  if (scale > 1) target.fill(0xff)
  const reader = compressedStream(compressed).pipeThrough(new DecompressionStream("deflate")).getReader()
  let sourceRowOffset = 0
  let completedRows = 0
  let targetOffset = 0

  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const bytes = next.value
      let sourceOffset = 0
      while (sourceOffset < bytes.length) {
        if (completedRows >= height) throw new Error("The APNG frame dimensions do not match its data.")
        if (sourceRowOffset === 0) {
          if (bytes[sourceOffset++] !== 0) {
            throw new Error("Only unfiltered APNG scanlines are supported.")
          }
          sourceRowOffset = 1
          if (sourceOffset === bytes.length) continue
        }
        const remaining = packedStride + 1 - sourceRowOffset
        const take = Math.min(remaining, bytes.length - sourceOffset)
        if (scale === 1) {
          target.set(bytes.subarray(sourceOffset, sourceOffset + take), targetOffset)
          targetOffset += take
        } else if (completedRows % scale === 0) {
          const outputRowOffset = (completedRows / scale) * outputStride
          for (let sourceByte = 0; sourceByte < take; sourceByte++) {
            const sourceByteIndex = sourceRowOffset - 1 + sourceByte
            const sourceXStart = sourceByteIndex * 8
            let bit = (scale - (sourceXStart % scale)) % scale
            for (; bit < 8; bit += scale) {
              const sourceX = sourceXStart + bit
              if (sourceX >= width) break
              if ((bytes[sourceOffset + sourceByte] & (0x80 >> bit)) !== 0) continue
              const outputX = sourceX / scale
              target[outputRowOffset + (outputX >> 3)] &= ~(0x80 >> (outputX & 7))
            }
          }
        }
        sourceOffset += take
        sourceRowOffset += take
        if (sourceRowOffset === packedStride + 1) {
          sourceRowOffset = 0
          completedRows++
        }
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (completedRows !== height || sourceRowOffset !== 0 || (scale === 1 && targetOffset !== packedLength)) {
    throw new Error("The APNG frame dimensions do not match its data.")
  }
}

/** Parse PNG chunks without materializing the whole file. Each callback owns
 * one compressed zlib frame assembled from zero-copy Blob slices. Awaiting the
 * callback is the parser's backpressure boundary. */
export async function streamApngFrames(
  file: ApngSource,
  onFrame: (frame: CompressedApngFrame) => Promise<void>,
): Promise<ApngInfo> {
  const fileSize = sourceSize(file)
  if (fileSize < PNG_SIGNATURE.length || !hasSignature(await readExact(file, 0, PNG_SIGNATURE.length))) {
    throw new Error("That file is not a PNG image.")
  }

  let width = 0
  let height = 0
  let animated = false
  let expectedFrames = 0
  let emittedFrames = 0
  let currentParts: ApngPart[] | undefined
  let paletteSeen = false
  let metadata: OpticalApngMetadata | undefined
  let endSeen = false
  let offset = PNG_SIGNATURE.length

  const emitCurrent = async (): Promise<void> => {
    const parts = currentParts
    if (!parts) return
    if (parts.length === 0) throw new Error("The APNG contains an empty frame.")
    if (!expectedFrames || emittedFrames >= expectedFrames) throw new Error("The APNG contains too many frames.")
    if (!metadata) throw new Error("The APNG is missing its QR metadata.")
    await onFrame({
      compressed: joinFrameParts(parts),
      width,
      height,
      metadata,
      index: emittedFrames,
      total: expectedFrames,
    })
    emittedFrames++
    currentParts = undefined
  }

  while (offset + 12 <= fileSize) {
    const header = await readExact(file, offset, 8)
    const chunkView = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const length = chunkView.getUint32(0)
    const type = chunkView.getUint32(4)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (!Number.isSafeInteger(dataEnd) || dataEnd + 4 > fileSize) throw new Error("The APNG file is truncated.")

    if (type === IHDR) {
      if (length !== 13) throw new Error("The PNG header is invalid.")
      const data = await readExact(file, dataStart, length)
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = view.getUint32(0)
      height = view.getUint32(4)
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error("The APNG dimensions are too large.")
      }
      if (data[8] !== 1 || data[9] !== 3 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Only 1-bit palette APNG exports are supported.")
      }
    } else if (type === PLTE) {
      if (!isExpectedPalette(await readExact(file, dataStart, length))) {
        throw new Error("The APNG palette does not match the expected black/white palette.")
      }
      paletteSeen = true
    } else if (type === ITXT) {
      const parsedMetadata = parseOpticalQrMetadataText(await readExact(file, dataStart, length))
      if (parsedMetadata === null) {
        // Standard PNG text belonging to another tool or workflow.
      } else if (parsedMetadata === undefined || metadata !== undefined) {
        throw new Error("The APNG QR metadata is invalid.")
      } else {
        metadata = parsedMetadata
      }
    } else if (type === ACTL) {
      if (length !== 8) throw new Error("The APNG animation header is invalid.")
      animated = true
      const data = await readExact(file, dataStart, length)
      expectedFrames = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0)
      if (!expectedFrames || expectedFrames > MAX_FRAMES) throw new Error("The APNG contains too many frames.")
    } else if (type === FCTL) {
      if (length !== 26) throw new Error("The APNG frame header is invalid.")
      if (!metadata) throw new Error("The APNG is missing its QR metadata.")
      apngFrameGeometry(width, height, metadata)
      await emitCurrent()
      const data = await readExact(file, dataStart, length)
      const frameView = new DataView(data.buffer, data.byteOffset, data.byteLength)
      if (
        !width ||
        !height ||
        frameView.getUint32(4) !== width ||
        frameView.getUint32(8) !== height ||
        frameView.getUint32(12) !== 0 ||
        frameView.getUint32(16) !== 0
      ) {
        throw new Error("Only full-frame APNG exports are supported.")
      }
      currentParts = []
    } else if (type === IDAT) {
      currentParts ??= []
      currentParts.push(sourceSlice(file, dataStart, dataEnd))
    } else if (type === FDAT) {
      if (!currentParts || length < 4) throw new Error("The APNG frame data is invalid.")
      currentParts.push(sourceSlice(file, dataStart + 4, dataEnd))
    } else if (type === IEND) {
      if (length !== 0) throw new Error("The PNG end marker is invalid.")
      await emitCurrent()
      endSeen = true
      break
    }
    offset = dataEnd + 4
  }

  if (!paletteSeen) throw new Error("The APNG is missing its black/white palette.")
  if (!metadata) throw new Error("The APNG is missing its QR metadata.")
  if (!width || !height || !animated || !expectedFrames || emittedFrames !== expectedFrames || !endSeen) {
    throw new Error("Choose an APNG exported by the QR sender.")
  }
  return { width, height, frames: emittedFrames, metadata }
}
