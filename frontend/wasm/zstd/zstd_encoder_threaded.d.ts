export interface ZstdEncoderModule {
  HEAPU8: Uint8Array
  UTF8ToString(pointer: number): string
  _malloc(size: number): number
  _free(pointer: number): void
  _pw_zstd_compress_bound(inputSize: number): number
  _pw_zstd_compress(
    input: number,
    inputSize: number,
    output: number,
    outputCapacity: number,
    level: number,
    written: number,
  ): number
  _pw_zstd_error_name(error: number): number
  _pw_zstd_compressor_new(level: number, pledgedSize: number, hasPledgedSize: number): number
  _pw_zstd_compressor_free(context: number): void
  _pw_zstd_compressor_push(context: number, input: number, inputSize: number): number
  _pw_zstd_compressor_finish(context: number): number
  _pw_zstd_compressor_output(context: number): number
  _pw_zstd_compressor_output_size(context: number): number
}

export interface ZstdEncoderModuleOptions {
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Exports
}

export default function createZstdEncoder(options?: ZstdEncoderModuleOptions): Promise<ZstdEncoderModule>
