import { initializeZstdDecoder } from "./zstd-runtime.js"
import {
  compileWasmModule,
  createRetryableLoader,
  selectWasmSimd,
  supportsWasmThreads,
  type WasmVariant,
} from "../utils/wasm.js"

// Keep the compile-time literal local to the URL branches. Vite can then omit
// the unused standalone asset before it inlines data URLs.
declare const __WASM_VARIANT__: WasmVariant
const zstdWasmVariant = __WASM_VARIANT__

/** Below this size, worker startup and zstd job scheduling cost more than the
 * parallel encoder can recover. Keep the ordinary SIMD module hot instead. */
export const ZSTD_THREADED_MIN_INPUT_BYTES = 64 * 1024 * 1024

const loadSingleThreadedEncoderModule = createRetryableLoader(async () => {
  const useSimd = selectWasmSimd(
    zstdWasmVariant,
    "This zstd codec build requires WebAssembly SIMD. Use the scalar standalone build instead.",
  )
  let url: string
  if (zstdWasmVariant === "simd") {
    url = new URL("./zstd/zstd_encoder_simd.wasm", import.meta.url).href
  } else if (zstdWasmVariant === "scalar") {
    url = new URL("./zstd/zstd_encoder_scalar.wasm", import.meta.url).href
  } else {
    url = useSimd
      ? new URL("./zstd/zstd_encoder_simd.wasm", import.meta.url).href
      : new URL("./zstd/zstd_encoder_scalar.wasm", import.meta.url).href
  }
  return await compileWasmModule(url, `zstd ${useSimd ? "SIMD" : "scalar"} encoder`)
})

const loadThreadedEncoderModule = createRetryableLoader(async () => {
  const url = new URL("./zstd/zstd_encoder_threaded.wasm", import.meta.url).href
  return await compileWasmModule(url, "zstd threaded SIMD encoder")
})

const loadDecoderModule = createRetryableLoader(async () => {
  const useSimd = selectWasmSimd(
    zstdWasmVariant,
    "This zstd codec build requires WebAssembly SIMD. Use the scalar standalone build instead.",
  )
  let url: string
  if (zstdWasmVariant === "simd") {
    url = new URL("./zstd/zstd_decoder_simd.wasm", import.meta.url).href
  } else if (zstdWasmVariant === "scalar") {
    url = new URL("./zstd/zstd_decoder_scalar.wasm", import.meta.url).href
  } else {
    url = useSimd
      ? new URL("./zstd/zstd_decoder_simd.wasm", import.meta.url).href
      : new URL("./zstd/zstd_decoder_scalar.wasm", import.meta.url).href
  }
  return await compileWasmModule(url, `zstd ${useSimd ? "SIMD" : "scalar"} decoder`)
})

/** Fetch and compile the selected encoder once in the current page realm.
 * Rejected attempts are cleared so a later operation can retry. */
export function loadZstdEncoderWasmModule(inputBytes = 0): Promise<WebAssembly.Module> {
  const useThreads =
    zstdWasmVariant === "auto" &&
    inputBytes >= ZSTD_THREADED_MIN_INPUT_BYTES &&
    selectWasmSimd(zstdWasmVariant, "") &&
    supportsWasmThreads()
  return useThreads ? loadThreadedEncoderModule() : loadSingleThreadedEncoderModule()
}

/** Register initialization immediately so codec calls can await the same load. */
export function ensureZstdDecoderReady(): Promise<void> {
  return initializeZstdDecoder(loadDecoderModule)
}
