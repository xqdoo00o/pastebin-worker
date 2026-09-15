import createNanoRQCodec, { type NanoRQCodecModule, type NanoRQCodecOptions } from "../nanorq-codec/nanorq_codec.js"
import { createRetryableLoader } from "../../utils/wasm.js"
import { RAPTORQ_PAYLOAD_ID_BYTES } from "./wire.js"
import type { QrBitmap, QrErrorCorrection } from "./qr.js"

type NanoRQInitInput = ArrayBuffer | Uint8Array | WebAssembly.Module

let module: NanoRQCodecModule | undefined

const initializeModule = createRetryableLoader(async (moduleOrBytes: NanoRQInitInput) => {
  let options: NanoRQCodecOptions
  if (moduleOrBytes instanceof WebAssembly.Module) {
    options = {
      instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(moduleOrBytes, imports)
        done(instance, moduleOrBytes)
        return instance.exports
      },
    }
  } else {
    options = { wasmBinary: moduleOrBytes }
  }
  return (module = await createNanoRQCodec(options))
})

/** Initialize the shared Emscripten module once in the current worker. */
export function initializeNanoRQ(moduleOrBytes: NanoRQInitInput): Promise<NanoRQCodecModule> {
  return initializeModule(moduleOrBytes)
}

function initializedModule(): NanoRQCodecModule {
  if (!module) throw new Error("NanoRQ has not been initialized.")
  return module
}

const QR_ECC: Readonly<Record<QrErrorCorrection, number>> = { L: 0, M: 1, Q: 2, H: 3 }
const QR_VERSION_MIN = 1
const QR_VERSION_MAX = 40
const TRANSFER_QR_MASK = 3

/** Generate fixed-mask binary QR symbols inside the NanoRQ WASM module.
 * Returned matrices remain valid until this generator encodes the next symbol. */
export class WasmNanoRQQrGenerator {
  private readonly codec: NanoRQCodecModule
  private handle = 0
  private inputPointer = 0
  private packedPointer = 0
  private readonly inputCapacity: number

  constructor() {
    this.codec = initializedModule()
    this.handle = this.codec._nanorq_qr_new()
    if (!this.handle) throw new Error("NanoRQ QR generator initialization failed.")
    this.inputCapacity = this.codec._nanorq_qr_input_capacity()
    this.inputPointer = this.codec._nanorq_qr_input(this.handle)
    this.packedPointer = this.codec._nanorq_qr_packed(this.handle)
    if (!this.inputPointer || !this.packedPointer || this.inputCapacity < 1) {
      this.free()
      throw new Error("NanoRQ returned invalid QR buffers.")
    }
  }

  encode(bytes: Uint8Array, ecc: QrErrorCorrection, version?: number): QrBitmap {
    if (!this.handle) throw new Error("NanoRQ QR generator has been freed.")
    if (bytes.length > this.inputCapacity) throw new Error("QR generation failed: Too much data")
    const minVersion = version ?? QR_VERSION_MIN
    const maxVersion = version ?? QR_VERSION_MAX
    this.codec.HEAPU8.set(bytes, this.inputPointer)
    const size = this.codec._nanorq_qr_encode(
      this.handle,
      bytes.length,
      QR_ECC[ecc],
      minVersion,
      maxVersion,
      TRANSFER_QR_MASK,
    )
    if (!size) throw new Error("QR generation failed: Too much data")

    const packed = new Uint8Array(this.codec.HEAPU8.buffer, this.packedPointer, Math.ceil((size * size) / 8))
    return {
      size,
      packed,
    }
  }

  free(): void {
    if (this.handle) this.codec._nanorq_qr_free(this.handle)
    this.handle = 0
    this.inputPointer = 0
    this.packedPointer = 0
  }
}

export class WasmNanoRQEncoder {
  readonly sourceSymbols: number
  readonly packetLength: number
  private readonly codec: NanoRQCodecModule
  private handle = 0
  private packetPointer = 0
  private packetView: Uint8Array<ArrayBufferLike> | undefined

  constructor(source: Uint8Array, symbolSize: number) {
    this.codec = initializedModule()
    this.handle = this.codec._nanorq_encoder_new(source.length, symbolSize)
    if (!this.handle) throw new Error("NanoRQ encoder initialization failed.")
    try {
      const sourcePointer = this.codec._nanorq_encoder_source(this.handle)
      const sourceStride = this.codec._nanorq_encoder_source_stride(this.handle)
      if (!sourcePointer || sourceStride < symbolSize) throw new Error("NanoRQ returned an invalid source matrix.")
      if (sourceStride === symbolSize) {
        this.codec.HEAPU8.set(source, sourcePointer)
      } else {
        for (let offset = 0, symbol = 0; offset < source.length; offset += symbolSize, symbol++) {
          this.codec.HEAPU8.set(source.subarray(offset, offset + symbolSize), sourcePointer + symbol * sourceStride)
        }
      }
      if (!this.codec._nanorq_encoder_prepare(this.handle)) {
        throw new Error("NanoRQ encoder precalculation failed.")
      }
    } catch (error) {
      this.free()
      throw error
    }

    this.sourceSymbols = this.codec._nanorq_encoder_source_symbols(this.handle)
    this.packetLength = this.codec._nanorq_encoder_packet_length(this.handle)
    this.packetPointer = this.codec._nanorq_alloc(this.packetLength)
    if (!this.packetPointer) {
      this.free()
      throw new Error("NanoRQ could not allocate its output packet.")
    }
    this.refreshPacketView()
  }

  /**
   * Keep one view over the WASM output allocation for the encoding hot path.
   * Emscripten replaces HEAPU8 when memory grows, so refresh only in that rare
   * case instead of allocating a subarray view for every repair symbol.
   */
  private refreshPacketView(): Uint8Array<ArrayBufferLike> {
    const heap = this.codec.HEAPU8
    if (this.packetView?.buffer !== heap.buffer) {
      this.packetView = new Uint8Array(heap.buffer, this.packetPointer, this.packetLength)
    }
    return this.packetView
  }

  encodeRepair(sequence: number): Uint8Array {
    return this.encodeRepairInto(sequence, new Uint8Array(this.packetLength))
  }

  encodeRepairInto(sequence: number, output: Uint8Array): Uint8Array {
    if (!this.handle) throw new Error("NanoRQ encoder has been freed.")
    if (output.length !== this.packetLength) throw new Error("NanoRQ output packet length is invalid.")
    if (!this.codec._nanorq_encoder_repair(this.handle, sequence, this.packetPointer, this.packetLength)) {
      throw new Error(`NanoRQ failed to encode repair symbol ${sequence}.`)
    }
    output.set(this.refreshPacketView())
    return output
  }

  free(): void {
    if (this.handle) this.codec._nanorq_encoder_free(this.handle)
    if (this.packetPointer) this.codec._nanorq_free(this.packetPointer)
    this.handle = 0
    this.packetPointer = 0
    this.packetView = undefined
  }
}

export class WasmNanoRQDecoder {
  private readonly codec: NanoRQCodecModule
  private readonly packetLength: number
  private readonly transferLength: number
  private handle = 0
  private outputPointer = 0

  constructor(transferLength: number, symbolSize: number) {
    this.codec = initializedModule()
    this.packetLength = symbolSize + RAPTORQ_PAYLOAD_ID_BYTES
    this.transferLength = transferLength
    this.handle = this.codec._nanorq_decoder_new(transferLength, symbolSize)
    if (!this.handle) throw new Error("NanoRQ decoder initialization failed.")

    this.outputPointer = this.codec._nanorq_alloc(transferLength)
    if (!this.outputPointer) {
      this.free()
      throw new Error("NanoRQ could not allocate its decoder buffers.")
    }
  }

  add(packet: Uint8Array): Uint8Array | undefined {
    if (!this.handle) throw new Error("NanoRQ decoder has been freed.")
    if (packet.length !== this.packetLength) throw new Error("NanoRQ packet length is invalid.")
    const inputPointer = this.codec._nanorq_decoder_input(this.handle)
    if (!inputPointer) throw new Error("NanoRQ could not reserve its decoder input buffer.")
    this.codec.HEAPU8.set(packet, inputPointer)
    const result = this.codec._nanorq_decoder_commit(this.handle, this.outputPointer, this.transferLength)
    if (result < 0) throw new Error("NanoRQ decoder failed.")
    return result > 0
      ? this.codec.HEAPU8.slice(this.outputPointer, this.outputPointer + this.transferLength)
      : undefined
  }

  free(): void {
    if (this.handle) this.codec._nanorq_decoder_free(this.handle)
    if (this.outputPointer) this.codec._nanorq_free(this.outputPointer)
    this.handle = 0
    this.outputPointer = 0
  }
}
