/** RFC 6330 FEC Payload ID: one-byte SBN followed by a 24-bit ESI. */
export const RAPTORQ_PAYLOAD_ID_BYTES = 4

/** RFC 6330 section 5.1.2, K'_max. Optical streams use one source block. */
export const MAX_RAPTORQ_SOURCE_SYMBOLS = 56_403

/** Every frame carries part placement; multipart frames additionally carry
 * the whole-file transfer id used for early routing. */
export const STANDALONE_HEADER_LEN = 16
export const MULTIPART_HEADER_LEN = 24
export const WIRE_VERSION = 2
export const RAPTORQ_SYMBOL_ALIGNMENT = 8
export const FRAME_MAGIC0 = 0xd1
export const FRAME_MAGIC1 = 0xc3

export interface FramePart {
  index: number
  count: number
  transferId: bigint | undefined
}

export interface FrameHeader {
  totalLen: number
  containerTag: bigint
  part: FramePart
}

export function frameHeaderLength(partCount: number): number {
  return partCount === 0 ? STANDALONE_HEADER_LEN : MULTIPART_HEADER_LEN
}

export function alignedRaptorQSymbolLength(packetCapacity: number): number {
  const available = Math.floor(packetCapacity) - RAPTORQ_PAYLOAD_ID_BYTES
  return Math.max(0, Math.floor(available / RAPTORQ_SYMBOL_ALIGNMENT) * RAPTORQ_SYMBOL_ALIGNMENT)
}

/** RFC 6330 symbol size T, aligned to the codec's eight-byte Al. */
export function symbolLength(frameBytes: number, partCount: number): number {
  return alignedRaptorQSymbolLength(frameBytes - frameHeaderLength(partCount))
}

export function raptorQPacketEncodingSymbolId(packet: Uint8Array): number {
  return (packet[1] << 16) | (packet[2] << 8) | packet[3]
}

export function packFrameInto(header: FrameHeader, block: Uint8Array, output: Uint8Array): Uint8Array {
  const { index, count, transferId } = header.part
  if (!Number.isInteger(count) || count < 0 || count > 0x0f || !Number.isInteger(index) || index < 0 || index > count) {
    throw new Error("The optical frame part placement is invalid.")
  }
  if ((count === 0 && (index !== 0 || transferId !== undefined)) || (count !== 0 && transferId === undefined)) {
    throw new Error("The optical frame transfer id is invalid.")
  }
  const headerLen = frameHeaderLength(count)
  if (output.length !== headerLen + block.length) throw new Error("The optical frame buffer has the wrong length.")
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  view.setUint8(0, FRAME_MAGIC0)
  view.setUint8(1, FRAME_MAGIC1)
  view.setUint8(2, WIRE_VERSION)
  view.setUint32(3, header.totalLen, true)
  view.setBigUint64(7, header.containerTag, false)
  view.setUint8(15, (count << 4) | index)
  if (count !== 0) view.setBigUint64(16, transferId!, false)
  if (block.buffer !== output.buffer || block.byteOffset !== output.byteOffset + headerLen) output.set(block, headerLen)
  return output
}

export function packFrame(header: FrameHeader, block: Uint8Array): Uint8Array {
  return packFrameInto(header, block, new Uint8Array(frameHeaderLength(header.part.count) + block.length))
}
