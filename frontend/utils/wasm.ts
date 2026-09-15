import { errorMessage } from "./errors.js"

export type WasmVariant = "auto" | "simd" | "scalar"

export type WasmInitInput = BufferSource | WebAssembly.Module
export type WasmInitSource = WasmInitInput | PromiseLike<WasmInitInput>
export type LazyWasmInitSource = WasmInitSource | (() => WasmInitSource)

export interface EmscriptenFactoryOptions {
  instantiateWasm: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => WebAssembly.Exports
}

export type EmscriptenFactory<T> = (options: EmscriptenFactoryOptions) => Promise<T>

export interface WasmMemoryModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
}

// Hosted builds use "auto". Standalone exports replace this with one literal
// so Rollup can discard the unused codec variant and its inlined WASM asset.
declare const __WASM_VARIANT__: WasmVariant

export const configuredWasmVariant = __WASM_VARIANT__

// Minimal valid WASM module using a v128 instruction. WebAssembly.validate()
// accepts it exactly on engines with WebAssembly SIMD support.
const SIMD_TEST = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00,
  0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
])

let wasmSimdSupported: boolean | undefined
let wasmThreadsSupported: boolean | undefined

export function supportsWasmSimd(): boolean {
  return (wasmSimdSupported ??= WebAssembly.validate(SIMD_TEST))
}

/** Shared WebAssembly memory is exposed only to cross-origin-isolated pages.
 * Constructing a tiny memory also catches engines which expose
 * SharedArrayBuffer but do not implement Wasm threads. */
export function supportsWasmThreads(): boolean {
  if (wasmThreadsSupported !== undefined) return wasmThreadsSupported
  if (globalThis.crossOriginIsolated !== true || typeof globalThis.SharedArrayBuffer === "undefined") {
    return (wasmThreadsSupported = false)
  }
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
    return (wasmThreadsSupported = memory.buffer instanceof SharedArrayBuffer)
  } catch {
    return (wasmThreadsSupported = false)
  }
}

/** Select the configured implementation without eagerly loading or compiling it. */
export function selectWasmSimd(variant: WasmVariant, unsupportedMessage: string): boolean {
  const simdSupported = supportsWasmSimd()
  if (variant === "simd" && !simdSupported) throw new Error(unsupportedMessage)
  return variant === "simd" || (variant === "auto" && simdSupported)
}

/** Cache one in-flight/successful load, but clear a rejected attempt so an
 * explicit user retry can recover from a transient fetch or compilation
 * failure without reloading the page. */
export function createRetryableLoader<Args extends unknown[], T>(
  load: (...args: Args) => T | PromiseLike<T>,
): (...args: Args) => Promise<T> {
  let pending: Promise<T> | undefined
  return (...args) => {
    pending ??= Promise.resolve()
      .then(() => load(...args))
      .catch((error) => {
        pending = undefined
        throw error
      })
    return pending
  }
}

export function resolveWasmInitSource(source: LazyWasmInitSource): Promise<WasmInitInput> {
  return Promise.resolve(typeof source === "function" ? source() : source)
}

/** Instantiate an Emscripten ES-module factory from a compiled module or bytes. */
export async function instantiateEmscriptenModule<T>(
  source: WasmInitInput,
  loadFactory: () => Promise<EmscriptenFactory<T>>,
): Promise<T> {
  const compiledModule = source instanceof WebAssembly.Module ? Promise.resolve(source) : WebAssembly.compile(source)
  const [compiled, createModule] = await Promise.all([compiledModule, loadFactory()])
  return await createModule({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports)
      done(instance, compiled)
      return instance.exports
    },
  })
}

export function allocateWasm(module: WasmMemoryModule, size: number, label: string): number {
  const pointer = module._malloc(Math.max(1, size))
  if (pointer === 0) throw new Error(`${label}: WebAssembly memory allocation failed`)
  return pointer
}

/** Reuse one growable WASM input allocation for streaming codec calls. */
export class ReusableWasmInput<M extends WasmMemoryModule = WasmMemoryModule> {
  private pointer = 0
  private capacity = 0

  constructor(
    private readonly module: M,
    private readonly label = "WASM codec",
  ) {}

  withBytes<T>(input: Uint8Array, action: (pointer: number) => T): T {
    if (input.byteLength === 0) return action(0)
    if (input.byteLength > this.capacity) {
      const pointer = allocateWasm(this.module, input.byteLength, this.label)
      if (this.pointer !== 0) this.module._free(this.pointer)
      this.pointer = pointer
      this.capacity = input.byteLength
    }
    this.module.HEAPU8.set(input, this.pointer)
    return action(this.pointer)
  }

  free(): void {
    if (this.pointer === 0) return
    this.module._free(this.pointer)
    this.pointer = 0
    this.capacity = 0
  }
}

function loadError(label: string, phase: string, cause: unknown): Error {
  const detail = errorMessage(cause)
  return new Error(`${label}: ${phase}${detail ? `: ${detail}` : ""}`)
}

async function compileBuffered(response: Response, label: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compile(await response.arrayBuffer())
  } catch (cause) {
    throw loadError(label, "WASM compilation failed", cause)
  }
}

/** Compile one WASM asset. Hosted assets stream-compile when possible; inlined
 * standalone data URLs use buffered compilation for Safari/file:// support. */
export async function compileWasmModule(url: string, label: string): Promise<WebAssembly.Module> {
  let response: Response
  try {
    response = await fetch(url, { credentials: "same-origin" })
  } catch (cause) {
    throw loadError(label, "WASM download failed", cause)
  }
  if (!response.ok) throw new Error(`${label}: ${response.status} ${response.statusText}`)
  // WebKit can leave compileStreaming(data:) pending forever when a standalone
  // page is opened from file://, so do not attempt the streaming path there.
  if (url.startsWith("data:")) return compileBuffered(response, label)
  try {
    return await WebAssembly.compileStreaming(response.clone())
  } catch {
    // Some static hosts omit application/wasm. Reuse the original response
    // body instead of issuing a second request.
    return compileBuffered(response, label)
  }
}
