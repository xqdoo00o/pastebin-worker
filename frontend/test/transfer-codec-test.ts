import { readFileSync } from "node:fs"
import { createStreamingZstdCompressor, initializeZstdDecoder, initializeZstdEncoder } from "../wasm/zstd-runtime.js"
import { initializeXXHash } from "../wasm/xxhash-runtime.js"

/** Initialize transfer codecs from local assets without browser fetches. */
export async function initializeTransferTestCodecs(): Promise<void> {
  await Promise.all([
    initializeZstdEncoder(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm")),
    initializeZstdDecoder(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm")),
    initializeXXHash(readFileSync("frontend/wasm/xxhash/xxhash_simd.wasm")),
  ])
}

/** Produce a single size-declared frame through the production streaming encoder. */
export async function compressZstdForTest(bytes: Uint8Array, level?: number): Promise<Uint8Array> {
  const compressor = await createStreamingZstdCompressor({ level, pledgedSize: bytes.byteLength })
  try {
    const chunks = [compressor.push(bytes), compressor.finish()]
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  } finally {
    compressor.free()
  }
}
