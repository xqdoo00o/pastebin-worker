import { compileWasmModule, configuredWasmVariant, createRetryableLoader, selectWasmSimd } from "../../utils/wasm.js"

/** Select the matching QR decoder binary while retaining one Emscripten glue
 * module. Keeping URLs in separate branches lets standalone builds remove the
 * unused variant entirely. */
const loadOpticalCodec = createRetryableLoader(async () => {
  const simd = selectWasmSimd(
    configuredWasmVariant,
    "This optical QR build requires WebAssembly SIMD. Use the scalar standalone build instead.",
  )
  const url = simd
    ? new URL("./optical_codec_simd.wasm", import.meta.url).href
    : new URL("./optical_codec_scalar.wasm", import.meta.url).href
  return compileWasmModule(url, `optical ${simd ? "SIMD" : "scalar"} codec`)
})

export function loadOpticalCodecModule(): Promise<WebAssembly.Module> {
  return loadOpticalCodec()
}
