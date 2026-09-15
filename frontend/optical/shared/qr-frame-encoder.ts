import { RaptorQEncoder } from "./fountain.js"
import { WasmNanoRQQrGenerator } from "./nanorq-runtime.js"
import { qrVersion, type QrBitmap, type QrErrorCorrection } from "./qr.js"
import { frameHeaderLength, packFrameInto, symbolLength, type FrameHeader, type FramePart } from "./wire.js"

export interface OpticalQrFrameEncoderOptions {
  container: Uint8Array
  containerTag: bigint
  part: FramePart
  frameBytes: number
  ecc: QrErrorCorrection
}

/**
 * Shared wire-frame and QR generator for live streams and finite exports.
 *
 * Sequence policy deliberately stays with the caller: a live stream advances
 * forever, while an exported carousel chooses a finite set of sequence
 * numbers. Both paths still produce byte-for-byte identical QR symbols for
 * the same container and sequence.
 */
export class OpticalQrFrameEncoder {
  readonly k: number
  readonly packetLen: number

  private readonly encoder: RaptorQEncoder
  private readonly qrGenerator: WasmNanoRQQrGenerator
  private readonly header: FrameHeader
  private readonly ecc: QrErrorCorrection
  private readonly wireFrame: Uint8Array
  private readonly block: Uint8Array
  private lockedVersion?: number
  private moduleCount = 0

  constructor({ container, containerTag, part, frameBytes, ecc }: OpticalQrFrameEncoderOptions) {
    const headerLen = frameHeaderLength(part.count)
    this.encoder = new RaptorQEncoder(container, symbolLength(frameBytes, part.count))
    try {
      this.qrGenerator = new WasmNanoRQQrGenerator()
    } catch (error) {
      this.encoder.free()
      throw error
    }
    this.k = this.encoder.k
    this.packetLen = this.encoder.packetLen
    this.header = {
      totalLen: container.length,
      containerTag,
      part,
    }
    this.ecc = ecc
    this.wireFrame = new Uint8Array(headerLen + this.packetLen)
    this.block = this.wireFrame.subarray(headerLen)
  }

  get version(): number | undefined {
    return this.lockedVersion
  }

  get modules(): number {
    return this.moduleCount
  }

  encode(sequence: number): QrBitmap {
    this.encoder.encodeInto(sequence, this.block)
    packFrameInto(this.header, this.block, this.wireFrame)
    const qr = this.qrGenerator.encode(this.wireFrame, this.ecc, this.lockedVersion)
    if (this.lockedVersion === undefined) {
      this.lockedVersion = qrVersion(qr)
      this.moduleCount = qr.size
    }
    return qr
  }

  free(): void {
    this.qrGenerator.free()
    this.encoder.free()
  }
}
