// Frame protocol: every QR frame is fully self-describing, so there is NO
// handshake — the receiver locks onto a stream mid-flight. The container tag
// identifies byte-identical transfers and lets symbols survive sender restarts.
//
// Layout, 16 bytes for a standalone file or 24 bytes for a multipart piece,
// followed by one serialized RFC 6330
// encoding packet. Its length, source-symbol count and sequence are derived
// from the QR payload length, transfer length and standard FEC Payload ID:
//   0  u8   magic 0xD1  ┐ fixed signature for this optical protocol
//   1  u8   magic 0xC3  ┘
//   2  u8   version     wire format version — currently 2
//   3  u32  totalLen    DCF container length, little-endian
//   7  8B   containerTag complete canonical XXH3-64(DCF)
//  15  u8   part        high nibble = total pieces - 1; low nibble = part index
//  16  8B   transferId  canonical XXH3-64(whole file), multipart only

import mime from "mime"
import { STREAMING_FILE_READ_CHUNK_BYTES } from "../../../shared/constants.js"
import { decompressZstd } from "../../wasm/zstd-runtime.js"
import { xxh3, xxh3Chunked } from "../../wasm/xxhash-runtime.js"
import { readByteSourceRangeChunks, type RandomAccessByteSource } from "../../utils/byteSource.js"
import { MAX_RAPTORQ_SOURCE_SYMBOLS, RAPTORQ_PAYLOAD_ID_BYTES } from "./wire.js"
import {
  alignedRaptorQSymbolLength,
  FRAME_MAGIC0,
  FRAME_MAGIC1,
  frameHeaderLength,
  MULTIPART_HEADER_LEN,
  packFrame,
  packFrameInto,
  raptorQPacketEncodingSymbolId,
  RAPTORQ_SYMBOL_ALIGNMENT,
  STANDALONE_HEADER_LEN,
  symbolLength,
  type FrameHeader,
  type FramePart,
  WIRE_VERSION,
} from "./wire.js"
import { isPrecompressedType } from "../../utils/precompressed.js"
export { isPrecompressedType }
export { MAX_RAPTORQ_SOURCE_SYMBOLS, RAPTORQ_PAYLOAD_ID_BYTES }
export {
  alignedRaptorQSymbolLength,
  frameHeaderLength,
  MULTIPART_HEADER_LEN,
  packFrame,
  packFrameInto,
  raptorQPacketEncodingSymbolId,
  RAPTORQ_SYMBOL_ALIGNMENT,
  STANDALONE_HEADER_LEN,
  symbolLength,
  WIRE_VERSION,
}
export type { FrameHeader, FramePart }

export function raptorQSourceSymbolCount(totalLength: number, symbolLength: number): number {
  return Math.ceil(totalLength / symbolLength)
}

// How much payload fits in a stream at a given frame size.
//
// Optical RaptorQ deliberately uses one RFC 6330 source block. A small QR
// payload can therefore hit K'_max before the application's file-size limit;
// the sender catches that before it starts the stream.
export const MAX_SOURCE_SYMBOLS = MAX_RAPTORQ_SOURCE_SYMBOLS

/** Source symbols a payload splits into at this frame size. */
export function sourceSymbolCount(payloadBytes: number, frameBytes: number, partCount: number): number {
  return raptorQSourceSymbolCount(payloadBytes, symbolLength(frameBytes, partCount))
}

export function fitsInOneStream(payloadBytes: number, frameBytes: number, partCount: number): boolean {
  return sourceSymbolCount(payloadBytes, frameBytes, partCount) <= MAX_SOURCE_SYMBOLS
}

/**
 * The smallest offered setting that works, so the sender can name a value that
 * is actually in the dropdown. Alignment makes the bare byte minimum an
 * incomplete test, so evaluate the ascending offered settings directly.
 */
export function smallestSufficientFrameSize(
  payloadBytes: number,
  options: readonly number[],
  partCount: number,
): number | undefined {
  return options.find((value) => fitsInOneStream(payloadBytes, value, partCount))
}

export const MAX_FILE_BYTES = 64 * 1024 * 1024
const FILE_HEADER_LEN = 17
/** Largest partCount expressible in its four-bit field. */
export const MAX_PART_COUNT = 0x0f

/** Largest whole file a multi-part optical transfer can carry: the sender
 * splits anything above MAX_FILE_BYTES into at most MAX_PART_COUNT+1 pieces. */
export const MAX_TRANSFER_BYTES = MAX_FILE_BYTES * (MAX_PART_COUNT + 1)

/** Largest DCF container, including bounded name/type metadata. */
const MAX_OPTICAL_CONTAINER_BYTES = MAX_FILE_BYTES + FILE_HEADER_LEN + 2 * 0xffff
const FILE_MAGIC = new Uint8Array([0x44, 0x43, 0x46, 0x35]) // DCF5
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type CompressionMode = "none" | "zstd" | "zstd-fragment"

/** Where one container sits in a multi-part transfer, or the standalone marker. */
export interface OpticalPart extends FramePart {
  /** Zero-based piece index; 0 is the first piece. */
  index: number
  /** Zero-based piece count — total pieces is count + 1; 0 means standalone. */
  count: number
  /** Complete XXH3-64 over the whole file, shared by every piece.
   * Only present when count !== 0. */
  transferId: bigint | undefined
}

export interface PackedOpticalFile {
  container: Uint8Array
  containerTag: bigint
  compression: CompressionMode
  originalSize: number
  transmittedSize: number
  part: OpticalPart
}

export interface OpticalFile {
  name: string
  type: string
  bytes: Uint8Array
  compression: CompressionMode
  transmittedSize: number
  /** Whole-file decompressed size; set only on zstd-fragment pieces. */
  decompressedSize?: number
  part: OpticalPart
}

/** Complete XXH3-64 over a byte sequence. The containerTag that identifies a
 * stream and the transferId that binds a multi-part file together both use
 * this digest over their exact bytes. */
export async function getXXH3(bytes: Uint8Array): Promise<bigint> {
  if (bytes.byteLength <= STREAMING_FILE_READ_CHUNK_BYTES) return await xxh3(bytes)
  return await xxh3Chunked(bytes, STREAMING_FILE_READ_CHUNK_BYTES)
}

// Decompression is delegated to the shared zstd runtime, which bounds output
// against the declared file length.

/**
 * Reduce a name to a bare basename.
 *
 * Applied on BOTH ends. The sender doing it is a convenience; the receiver
 * doing it is the part that matters, because the name it unpacks arrived over
 * the optical channel and is whatever the other screen chose to display. The
 * `download` attribute is the only consumer and browsers sanitise it too, but
 * the receiver has no reason to take the sender's word for it.
 */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  // Strip control characters (NUL and newlines in particular) and the
  // relative-path names that survive a basename split.
  const cleaned = base.replace(/\p{Cc}/gu, "").trim()
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "transfer.bin" : cleaned
}

interface StreamingContainerPayload {
  length: number
  writeTo(destination: Uint8Array): Promise<void>
}

interface PackedContainerParts {
  nameBytes: Uint8Array
  typeBytes: Uint8Array
  /** Payload written into the container: a raw slice, a zstd frame, or a fragment. */
  payload: Uint8Array | StreamingContainerPayload
  /** Declared original byte length (the fileLength header field). */
  decompressedLength: number
  /** 0 = none, 1 = zstd, 2 = zstd fragment of a whole-file frame. */
  mode: "none" | "zstd" | "zstd-fragment"
  partCount: number
  partIndex: number
  transferId: bigint | undefined
}

interface PreparedFileMetadata {
  mediaType: string
  nameBytes: Uint8Array
  typeBytes: Uint8Array
}

export interface PackTransferPayloadOptions {
  /** How the already-prepared payload is represented on the wire. */
  compression: CompressionMode
  /** Original size recorded in the container header. */
  originalSize: number
  /** Zero-based piece index within the transfer. */
  index: number
  /** Zero-based piece count — total pieces is count + 1. */
  count: number
  /** Shared whole-file digest prefix; required for multipart transfers. */
  transferId?: bigint
}

/** Normalize and validate container metadata once for both standalone and
 * multi-part transfers. Keeping this at the shared entry point prevents the
 * two packing paths from accepting different wire values. */
function prepareFileMetadata(name: string, type: string): PreparedFileMetadata {
  const nameBytes = textEncoder.encode(safeFileName(name))
  const mediaType = type.trim() || mime.getType(name) || "application/octet-stream"
  const typeBytes = textEncoder.encode(mediaType)
  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    throw new Error("The file name or media type is too long.")
  }
  return { mediaType, nameBytes, typeBytes }
}

/** Resolve the media type exactly as the container writer does. */
function opticalFileMediaType(name: string, type: string): string {
  return prepareFileMetadata(name, type).mediaType
}

/** Maximum zstd bytes assigned to one part while leaving room for metadata,
 * the container header and the protocol's safety margin. */
export function compressedPartPayloadLimit(
  name: string,
  type: string,
  partPayloadSize: number = MAX_FILE_BYTES,
): number {
  if (partPayloadSize <= 0 || partPayloadSize > MAX_FILE_BYTES) {
    throw new RangeError("Invalid optical part payload size.")
  }
  const { nameBytes, typeBytes } = prepareFileMetadata(name, type)
  return partPayloadSize - FILE_HEADER_LEN - nameBytes.length - typeBytes.length - 64
}

/** Whether preparing this file can benefit from loading the zstd encoder. */
export function isOpticalCompressionCandidate(
  name: string,
  type: string,
  size: number,
  partPayloadSize: number = MAX_FILE_BYTES,
): boolean {
  return (
    Number.isSafeInteger(size) &&
    size >= 768 &&
    size <= 0xffff_ffff &&
    compressedPartPayloadLimit(name, type, partPayloadSize) > 0 &&
    !isPrecompressedType(opticalFileMediaType(name, type))
  )
}

/** Exact size of a container before its payload is materialized. */
export function opticalContainerSize(name: string, type: string, payloadSize: number): number {
  const { nameBytes, typeBytes } = prepareFileMetadata(name, type)
  return FILE_HEADER_LEN + nameBytes.length + typeBytes.length + payloadSize
}

/** Serialize one self-describing container and digest it for the frame tag. */
async function buildPackedContainer({
  nameBytes,
  typeBytes,
  payload,
  decompressedLength,
  mode,
  partCount,
  partIndex,
  transferId,
}: PackedContainerParts): Promise<PackedOpticalFile> {
  const payloadLength = payload.length
  const compressionByte = mode === "zstd" ? 1 : mode === "zstd-fragment" ? 2 : 0
  const dataOffset = FILE_HEADER_LEN + nameBytes.length + typeBytes.length
  const out = new Uint8Array(dataOffset + payloadLength)
  const view = new DataView(out.buffer)
  out.set(FILE_MAGIC, 0)
  view.setUint8(4, compressionByte)
  view.setUint16(5, nameBytes.length, true)
  view.setUint16(7, typeBytes.length, true)
  view.setUint32(9, decompressedLength, true)
  view.setUint32(13, payloadLength, true)
  out.set(nameBytes, FILE_HEADER_LEN)
  out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length)
  // Typed arrays received from another worker/window Realm do not necessarily
  // pass this Realm's instanceof check, so distinguish the internal streaming
  // writer by capability instead.
  if ("writeTo" in payload) await payload.writeTo(out.subarray(dataOffset))
  else out.set(payload, dataOffset)
  return {
    container: out,
    containerTag: await getXXH3(out),
    compression: mode,
    originalSize: decompressedLength,
    transmittedSize: payloadLength,
    part: { index: partIndex, count: partCount, transferId },
  }
}

function validateTransferPayload(
  payloadLength: number,
  { compression, originalSize, index, count, transferId }: PackTransferPayloadOptions,
): void {
  if (payloadLength === 0) throw new Error("Choose a non-empty file.")
  if (!Number.isSafeInteger(payloadLength) || payloadLength > MAX_FILE_BYTES) {
    throw new RangeError("Optical source exceeds the supported size.")
  }
  if (!Number.isSafeInteger(originalSize) || originalSize <= 0 || originalSize > MAX_TRANSFER_BYTES) {
    throw new RangeError("Optical source exceeds the supported size.")
  }
  if (!Number.isInteger(count) || count < 0 || count > MAX_PART_COUNT) {
    throw new RangeError("The optical file has too many parts.")
  }
  if (!Number.isInteger(index) || index < 0 || index > count) {
    throw new RangeError("The optical file part index is invalid.")
  }
  if (count === 0 && index !== 0) throw new RangeError("A standalone optical file cannot have a non-zero part index.")
  if (count !== 0 && transferId === undefined) throw new Error("A multipart optical file requires a transfer ID.")
  if (compression === "zstd-fragment" && count === 0) {
    throw new Error("A zstd fragment must belong to a multipart optical file.")
  }
  if (compression === "none" && originalSize !== payloadLength) {
    throw new Error("A raw optical part must declare its payload size.")
  }
}

/** Pack a source range directly into its final container. Only one bounded
 * read chunk exists alongside the container, avoiding a second full-part
 * payload allocation for large optical pieces. */
export async function packTransferPayloadFromSource(
  name: string,
  type: string,
  source: RandomAccessByteSource,
  start: number,
  end: number,
  options: PackTransferPayloadOptions,
  signal?: AbortSignal,
): Promise<PackedOpticalFile> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.size) {
    throw new RangeError("The optical payload range is invalid.")
  }
  const payloadLength = end - start
  validateTransferPayload(payloadLength, options)
  const { compression, originalSize, index, count, transferId } = options
  const { nameBytes, typeBytes } = prepareFileMetadata(name, type)
  return await buildPackedContainer({
    nameBytes,
    typeBytes,
    payload: {
      length: payloadLength,
      async writeTo(destination) {
        let offset = 0
        for await (const chunk of readByteSourceRangeChunks(
          source,
          start,
          end,
          STREAMING_FILE_READ_CHUNK_BYTES,
          signal,
        )) {
          destination.set(chunk, offset)
          offset += chunk.byteLength
        }
      },
    },
    decompressedLength: originalSize,
    mode: compression,
    partCount: count,
    partIndex: index,
    transferId: count === 0 ? undefined : transferId,
  })
}

function hasMagic(container: Uint8Array, magic: Uint8Array): boolean {
  if (container.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) if (container[i] !== magic[i]) return false
  return true
}

/** The optional page-realm loader retries a failed speculative preload only
 * when the recovered container actually uses zstd. */
export async function unpackFile(
  container: Uint8Array,
  part: OpticalPart,
  ensureZstdReady?: () => Promise<void>,
): Promise<OpticalFile> {
  if (!hasMagic(container, FILE_MAGIC)) throw new Error("The recovered file header is invalid.")
  if (container.length < FILE_HEADER_LEN) throw new Error("The recovered file header is incomplete.")

  const { index: partIndex, count: partCount, transferId } = part
  if (!Number.isInteger(partCount) || partCount < 0 || partCount > MAX_PART_COUNT) {
    throw new Error("The recovered file part count is invalid.")
  }
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex > partCount) {
    throw new Error("The recovered file part index is invalid.")
  }
  if ((partCount === 0 && transferId !== undefined) || (partCount !== 0 && transferId === undefined)) {
    throw new Error("The recovered file transfer id is invalid.")
  }

  const view = new DataView(container.buffer, container.byteOffset, container.byteLength)
  const compressionByte = view.getUint8(4)
  if (compressionByte > 2) throw new Error("The recovered file uses unsupported compression.")
  const isFragment = compressionByte === 2
  if (isFragment && partCount === 0) throw new Error("A zstd fragment must belong to a multipart optical file.")
  const compression: CompressionMode = isFragment ? "zstd-fragment" : compressionByte === 1 ? "zstd" : "none"
  const nameLength = view.getUint16(5, true)
  const typeLength = view.getUint16(7, true)
  const fileLength = view.getUint32(9, true)
  const transmittedLength = view.getUint32(13, true)

  const dataOffset = FILE_HEADER_LEN + nameLength + typeLength
  if (
    fileLength === 0 ||
    // A whole file compressed in one part can exceed the per-part limit but
    // never the full multi-part ceiling.
    fileLength > MAX_TRANSFER_BYTES ||
    transmittedLength === 0 ||
    transmittedLength > MAX_FILE_BYTES ||
    dataOffset + transmittedLength !== container.length
  ) {
    throw new Error("The recovered file length does not match its header.")
  }

  const transmitted = container.subarray(dataOffset)
  let bytes: Uint8Array
  if (compression === "zstd") {
    // Self-contained zstd frame: bounded inflate against the declared length.
    await ensureZstdReady?.()
    bytes = await decompressZstd(transmitted, fileLength)
  } else {
    // Raw bytes, or a fragment of a whole-file zstd frame (inflated only
    // after every piece is concatenated on the receiver).
    bytes = transmitted
  }
  if (compression !== "zstd-fragment" && bytes.length !== fileLength) {
    throw new Error("The decompressed file length does not match its header.")
  }

  return {
    name: safeFileName(textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))),
    type:
      textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset)) || "application/octet-stream",
    bytes,
    compression,
    transmittedSize: transmittedLength,
    decompressedSize: isFragment ? fileLength : undefined,
    part: { index: partIndex, count: partCount, transferId },
  }
}

/** Header values plus the RaptorQ values derived from the packet itself. */
export interface DecodedFrameHeader extends FrameHeader {
  packetLen: number
}

/** Why a decoded QR payload can or cannot be consumed by this receiver. */
export type FrameVerdict =
  | { kind: "ok" }
  | { kind: "foreign" }
  | { kind: "older-sender"; version: number }
  | { kind: "newer-sender"; version: number }
  | { kind: "malformed" }

type RejectedFrameVerdict = Exclude<FrameVerdict, { kind: "ok" }>

export type InspectedFrame =
  | { verdict: RejectedFrameVerdict }
  | {
      verdict: { kind: "ok" }
      frame: { header: DecodedFrameHeader; block: Uint8Array }
    }

/**
 * Single owner of both protocol compatibility and untrusted header bounds.
 * Keeping these checks together ensures callers cannot disagree about whether
 * a frame is safe to hand to the fountain decoder.
 */
export function inspectFrame(bytes: Uint8Array): InspectedFrame {
  if (bytes.length < 4 || bytes[0] !== FRAME_MAGIC0) return { verdict: { kind: "foreign" } }
  if (bytes[1] !== FRAME_MAGIC1) return { verdict: { kind: "foreign" } }

  const version = bytes[2]
  if (version === 0) return { verdict: { kind: "malformed" } }
  if (version !== WIRE_VERSION) {
    return {
      verdict: version > WIRE_VERSION ? { kind: "newer-sender", version } : { kind: "older-sender", version },
    }
  }

  if (bytes.length <= STANDALONE_HEADER_LEN + RAPTORQ_PAYLOAD_ID_BYTES) {
    return { verdict: { kind: "malformed" } }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const partPlacement = dv.getUint8(15)
  const partCount = partPlacement >>> 4
  const partIndex = partPlacement & 0x0f
  if (partIndex > partCount) return { verdict: { kind: "malformed" } }
  const headerLen = frameHeaderLength(partCount)
  if (bytes.length <= headerLen + RAPTORQ_PAYLOAD_ID_BYTES) return { verdict: { kind: "malformed" } }
  const packetLen = bytes.length - headerLen
  const totalLen = dv.getUint32(3, true)
  const symbolLen = packetLen - RAPTORQ_PAYLOAD_ID_BYTES
  if (
    totalLen === 0 ||
    symbolLen <= 0 ||
    symbolLen % RAPTORQ_SYMBOL_ALIGNMENT !== 0 ||
    totalLen > MAX_OPTICAL_CONTAINER_BYTES
  ) {
    return { verdict: { kind: "malformed" } }
  }
  const k = raptorQSourceSymbolCount(totalLen, symbolLen)
  if (k > MAX_RAPTORQ_SOURCE_SYMBOLS) return { verdict: { kind: "malformed" } }
  const block = bytes.subarray(headerLen)
  // The optical profile uses one source block and emits repair-only symbols.
  // Reject source packets and non-zero source blocks before camera input
  // reaches WASM.
  if (block[0] !== 0 || raptorQPacketEncodingSymbolId(block) < k) {
    return { verdict: { kind: "malformed" } }
  }
  return {
    verdict: { kind: "ok" },
    frame: {
      header: {
        totalLen,
        containerTag: dv.getBigUint64(7, false),
        part: {
          index: partIndex,
          count: partCount,
          transferId: partCount === 0 ? undefined : dv.getBigUint64(16, false),
        },
        packetLen,
      },
      block,
    },
  }
}

export function frameVerdictMessage(verdict: FrameVerdict): string | null {
  switch (verdict.kind) {
    case "older-sender":
      return `That screen is sending an older QR transfer format (v${verdict.version}). Update the sending device.`
    case "newer-sender":
      return `That screen is sending a newer QR transfer format (v${verdict.version}). Update this receiver.`
    default:
      return null
  }
}

/**
 * Everything about a frame that has to hold constant for a decoder to keep
 * accepting frames into it. The derived repair sequence is deliberately absent
 * because it is the one value that varies within a stream.
 *
 * The receiver resets on any disagreement. Byte-identical objects deliberately
 * share an identity, so symbols captured across sender restarts can be merged.
 */
export function streamIdentity(h: DecodedFrameHeader): string {
  const transferId = h.part.transferId?.toString(16).padStart(16, "0") ?? "standalone"
  return `${transferId}:${h.part.count}:${h.part.index}:${h.containerTag.toString(16).padStart(16, "0")}:${h.packetLen}:${h.totalLen}`
}
