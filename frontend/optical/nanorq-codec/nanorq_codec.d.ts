export interface NanoRQCodecOptions {
  locateFile?: (path: string, prefix: string) => string
  wasmBinary?: ArrayBuffer | Uint8Array
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Exports
}

export interface NanoRQCodecModule {
  HEAPU8: Uint8Array
  _nanorq_alloc(length: number): number
  _nanorq_free(pointer: number): void
  _nanorq_encoder_new(transferLength: number, symbolSize: number): number
  _nanorq_encoder_source(encoder: number): number
  _nanorq_encoder_source_stride(encoder: number): number
  _nanorq_encoder_prepare(encoder: number): number
  _nanorq_encoder_source_symbols(encoder: number): number
  _nanorq_encoder_packet_length(encoder: number): number
  _nanorq_encoder_repair(encoder: number, sequence: number, packet: number, packetLength: number): number
  _nanorq_encoder_free(encoder: number): void
  _nanorq_decoder_new(transferLength: number, symbolSize: number): number
  _nanorq_decoder_input(decoder: number): number
  _nanorq_decoder_commit(decoder: number, output: number, outputLength: number): number
  _nanorq_decoder_free(decoder: number): void
  _nanorq_qr_new(): number
  _nanorq_qr_input_capacity(): number
  _nanorq_qr_input(qr: number): number
  _nanorq_qr_packed(qr: number): number
  _nanorq_qr_encode(
    qr: number,
    dataLength: number,
    ecc: number,
    minVersion: number,
    maxVersion: number,
    mask: number,
  ): number
  _nanorq_qr_free(qr: number): void
  _nanorq_simd_enabled(): number
  _nanorq_simd_self_test(): number
}

export default function createNanoRQCodec(options?: NanoRQCodecOptions): Promise<NanoRQCodecModule>
