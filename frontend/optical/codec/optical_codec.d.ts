export interface OpticalModule {
  _malloc(bytes: number): number
  _free(ptr: number): void
  HEAPU8: Uint8Array
  readFull(ptr: number, width: number, height: number, maxSymbols: number): Uint8Array[]
  readFullLum(ptr: number, width: number, height: number, maxSymbols: number): Uint8Array[]
  readModuleGridMono1(
    ptr: number,
    width: number,
    height: number,
    qrVersion: number,
    columns: number,
    rows: number,
  ): Uint8Array[]
  readFullBGRX(ptr: number, width: number, height: number, maxSymbols: number): Uint8Array[]
}

export default function OpticalCodec(options?: {
  locateFile?: (path: string, prefix: string) => string
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object
}): Promise<OpticalModule>
