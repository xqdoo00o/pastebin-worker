import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"

import createNanoRQCodec from "../../frontend/optical/nanorq-codec/nanorq_codec.js"

const root = new URL("../../frontend/optical/nanorq-codec/", import.meta.url)
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ["simd", "scalar"]
const cases = [
  { version: 15, ecc: 0, length: 500 },
  { version: 25, ecc: 0, length: 1000 },
  { version: 40, ecc: 0, length: 2953 },
  { version: 40, ecc: 2, length: 1465 },
  { version: 48, ecc: 0, length: 4143 },
  { version: 48, ecc: 1, length: 2953 },
  { version: 48, ecc: 2, length: 2331 },
  { version: 48, ecc: 3, length: 1450 },
]
const iterations = 2000

for (const variant of variants) {
  if (!["simd", "scalar"].includes(variant)) throw new Error(`Unknown variant: ${variant}`)
  const wasm = readFileSync(new URL(`nanorq_codec_${variant}.wasm`, root))
  const codec = await createNanoRQCodec({ wasmBinary: wasm })
  const qr = codec._nanorq_qr_new()
  if (!qr) throw new Error("QR allocation failed")
  const input = codec._nanorq_qr_input(qr)
  try {
    for (const { version, ecc, length } of cases) {
      const bytes = new Uint8Array(length)
      for (let i = 0; i < length; i++) bytes[i] = (i * 73 + 41) & 255
      let elapsed = 0
      for (let sample = 0; sample < 4; sample++) {
        const start = performance.now()
        for (let i = 0; i < iterations; i++) {
          bytes[i % length] ^= i & 255
          codec.HEAPU8.set(bytes, input)
          if (!codec._nanorq_qr_encode(qr, length, ecc, version, version, 3)) {
            throw new Error(`Encoding failed: ${version}/${ecc}/${length}`)
          }
        }
        if (sample > 0) elapsed += performance.now() - start
      }
      console.log(
        `${variant} v${version} ecc${ecc} ${length} bytes: ${((elapsed * 1000) / (3 * iterations)).toFixed(1)} us/symbol`,
      )
    }
  } finally {
    codec._nanorq_qr_free(qr)
  }
}
