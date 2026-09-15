export interface ZstdDecoderModule {
  HEAPU8: Uint8Array
  UTF8ToString(pointer: number): string
  _malloc(size: number): number
  _free(pointer: number): void
  _pw_zstd_error_name(error: number): number
  _pw_zstd_decompress_capacity(input: number, inputSize: number, maxOutput: number, capacity: number): number
  _pw_zstd_decompress(
    input: number,
    inputSize: number,
    output: number,
    outputCapacity: number,
    written: number,
  ): number
  _pw_zstd_decompressor_new(maxOutput: number): number
  _pw_zstd_decompressor_free(context: number): void
  _pw_zstd_decompressor_push(context: number, input: number, inputSize: number): number
  _pw_zstd_decompressor_finish(context: number): number
  _pw_zstd_decompressor_output(context: number): number
  _pw_zstd_decompressor_output_size(context: number): number
}

export interface ZstdDecoderModuleOptions {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Exports
}

export default function createZstdDecoder(options?: ZstdDecoderModuleOptions): Promise<ZstdDecoderModule>
