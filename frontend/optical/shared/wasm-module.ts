import { compileWasmModule, configuredWasmVariant, createRetryableLoader, selectWasmSimd } from "../../utils/wasm.js"

export { compileWasmModule, configuredWasmVariant, createRetryableLoader } from "../../utils/wasm.js"

/** Shared by the live sender, APNG exporter and receiver page in their
 * respective page realms. Select the SIMD implementation when available and
 * otherwise use the scalar-compatible build. */
const loadNanoRQModule = createRetryableLoader(async () => {
  const simd = selectWasmSimd(
    configuredWasmVariant,
    "This optical QR build requires WebAssembly SIMD. Use a scalar-compatible standalone build if one is available.",
  )
  // Keep the URLs inside the branches: after Vite substitutes the variant,
  // Rollup removes the unreachable branch and its corresponding WASM asset.
  const url = simd
    ? new URL("../nanorq-codec/nanorq_codec_simd.wasm", import.meta.url).href
    : new URL("../nanorq-codec/nanorq_codec_scalar.wasm", import.meta.url).href
  return compileWasmModule(url, `NanoRQ ${simd ? "SIMD" : "scalar"} codec`)
})

export function loadNanoRQCodecModule(): Promise<WebAssembly.Module> {
  return loadNanoRQModule()
}
