export interface XXHashModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  _pw_xxh3_64bits(input: number, length: number): bigint
  _pw_xxh3_state_new(): number
  _pw_xxh3_state_free(state: number): void
  _pw_xxh3_state_reset(state: number): number
  _pw_xxh3_state_update(state: number, input: number, length: number): number
  _pw_xxh3_state_digest(state: number): bigint
}

export interface XXHashFactoryOptions {
  wasmBinary?: ArrayBuffer | Uint8Array
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Exports
}

export default function createXXHash(options?: XXHashFactoryOptions): Promise<XXHashModule>
