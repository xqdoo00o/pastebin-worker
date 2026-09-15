import { initializeXXHash } from "./xxhash-runtime.js"
import { compileWasmModule, createRetryableLoader, selectWasmSimd, type WasmVariant } from "../utils/wasm.js"

declare const __WASM_VARIANT__: WasmVariant
const xxhashWasmVariant = __WASM_VARIANT__
const loadModule = createRetryableLoader(async () => {
  const useSimd = selectWasmSimd(
    xxhashWasmVariant,
    "This xxHash build requires WebAssembly SIMD. Use the scalar standalone build instead.",
  )
  let url: string
  if (xxhashWasmVariant === "simd") {
    url = new URL("./xxhash/xxhash_simd.wasm", import.meta.url).href
  } else if (xxhashWasmVariant === "scalar") {
    url = new URL("./xxhash/xxhash_scalar.wasm", import.meta.url).href
  } else {
    url = useSimd
      ? new URL("./xxhash/xxhash_simd.wasm", import.meta.url).href
      : new URL("./xxhash/xxhash_scalar.wasm", import.meta.url).href
  }
  return await compileWasmModule(url, `xxHash ${useSimd ? "SIMD" : "scalar"}`)
})

export function loadXXHashWasmModule(): Promise<WebAssembly.Module> {
  return loadModule()
}

export function ensureXXHashReady(): Promise<void> {
  return initializeXXHash(loadModule)
}
