import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import createZstdDecoder, { type ZstdDecoderModule } from "../wasm/zstd/zstd_decoder.js"
import createZstdEncoder, { type ZstdEncoderModule } from "../wasm/zstd/zstd_encoder.js"
import {
  compressZstd,
  createStreamingZstdCompressor,
  createStreamingZstdDecompressor,
  decompressZstd,
  initializeZstdDecoder,
  initializeZstdEncoder,
  ZSTD_LEVEL,
  ZSTD_MAX_LEVEL,
} from "../wasm/zstd-runtime.js"

beforeAll(async () => {
  const [encoderModule, decoderModule] = await Promise.all([
    WebAssembly.compile(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm")),
    WebAssembly.compile(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm")),
  ])
  await Promise.all([initializeZstdEncoder(encoderModule), initializeZstdDecoder(decoderModule)])
})

function join(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function instantiateEncoderVariant(variant: "simd" | "scalar"): Promise<ZstdEncoderModule> {
  const compiled = await WebAssembly.compile(readFileSync(`frontend/wasm/zstd/zstd_encoder_${variant}.wasm`))
  return await createZstdEncoder({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports)
      done(instance, compiled)
      return instance.exports
    },
  })
}

async function instantiateDecoder(): Promise<ZstdDecoderModule> {
  const compiled = await WebAssembly.compile(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm"))
  return await createZstdDecoder({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports)
      done(instance, compiled)
      return instance.exports
    },
  })
}

async function compressWithoutContentSize(source: Uint8Array): Promise<Uint8Array> {
  const compressor = await createStreamingZstdCompressor()
  try {
    return join([compressor.push(source), compressor.finish()])
  } finally {
    compressor.free()
  }
}

function decompressionCapacity(module: ZstdDecoderModule, compressed: Uint8Array, maxBytes: number): number {
  const input = module._malloc(compressed.byteLength)
  const capacity = module._malloc(Uint32Array.BYTES_PER_ELEMENT)
  try {
    module.HEAPU8.set(compressed, input)
    return module._pw_zstd_decompress_capacity(input, compressed.byteLength, maxBytes, capacity)
  } finally {
    module._free(capacity)
    module._free(input)
  }
}

describe("official zstd runtime", () => {
  it("uses zstd's library-default compression level", async () => {
    expect(ZSTD_LEVEL).toBe(0)
    const source = new TextEncoder().encode("default compression level ".repeat(100))
    expect(await compressZstd(source)).toStrictEqual(await compressZstd(source, 0))
  })

  it("retains level 4 and rejects compression levels excluded from the WASM build", async () => {
    const source = new TextEncoder().encode("bounded compression level ".repeat(100))
    const restored = await decompressZstd(await compressZstd(source, ZSTD_MAX_LEVEL), source.byteLength)
    expect(restored.byteLength).toBe(source.byteLength)
    expect(restored.findIndex((byte, index) => byte !== source[index])).toBe(-1)
    await expect(compressZstd(source, ZSTD_MAX_LEVEL + 1)).rejects.toThrow(/integer from -131072 through 4/)
    await expect(createStreamingZstdCompressor(ZSTD_MAX_LEVEL + 1)).rejects.toThrow(/integer from -131072 through 4/)
  })

  it("round-trips arbitrary compression chunks and one-byte decompression pushes", async () => {
    const source = new TextEncoder().encode("official Meta zstd streaming ".repeat(10_000))
    const compressor = await createStreamingZstdCompressor()
    const compressed: Uint8Array[] = []
    try {
      for (let offset = 0; offset < source.byteLength; offset += 997) {
        compressed.push(compressor.push(source.subarray(offset, offset + 997)))
      }
      compressed.push(compressor.finish())
    } finally {
      compressor.free()
    }

    const decoder = await createStreamingZstdDecompressor(source.byteLength)
    const restored: Uint8Array[] = []
    try {
      for (const byte of join(compressed)) restored.push(decoder.push(Uint8Array.of(byte)))
      restored.push(decoder.push(new Uint8Array()))
      decoder.finish()
    } finally {
      decoder.free()
    }
    const output = join(restored)
    expect(output.byteLength).toBe(source.byteLength)
    expect(output.findIndex((byte, index) => byte !== source[index])).toBe(-1)
  })

  it("records and validates a pledged streaming input size", async () => {
    const source = new TextEncoder().encode("pledged streaming source ".repeat(20_000))
    const compressor = await createStreamingZstdCompressor({ pledgedSize: source.byteLength })
    const compressed: Uint8Array[] = []
    try {
      compressed.push(compressor.push(source.subarray(0, 123_456)))
      compressed.push(compressor.push(source.subarray(123_456)))
      compressed.push(compressor.finish())
    } finally {
      compressor.free()
    }
    const restored = await decompressZstd(join(compressed), source.byteLength)
    expect(restored.byteLength).toBe(source.byteLength)
    expect(restored.findIndex((byte, index) => byte !== source[index])).toBe(-1)

    const mismatched = await createStreamingZstdCompressor({ pledgedSize: source.byteLength + 1 })
    try {
      mismatched.push(source)
      expect(() => mismatched.finish()).toThrow(/Src size is incorrect/)
    } finally {
      mismatched.free()
    }
  })

  it.each(["simd", "scalar"] as const)("preserves pledged source-size high bits in the %s build", async (variant) => {
    const module = await instantiateEncoderVariant(variant)
    const lowWordSize = 17
    let context = 0
    let input = 0
    try {
      // If the f64 WASM boundary discarded the high 32 bits, this pledge
      // would become exactly lowWordSize and finish() would incorrectly pass.
      context = module._pw_zstd_compressor_new(0, 0x1_0000_0000 + lowWordSize, 1)
      expect(context).not.toBe(0)
      input = module._malloc(lowWordSize)
      expect(input).not.toBe(0)
      module.HEAPU8.fill(42, input, input + lowWordSize)
      expect(module._pw_zstd_compressor_push(context, input, lowWordSize)).toBe(0)
      const status = module._pw_zstd_compressor_finish(context)
      expect(status).not.toBe(0)
      expect(module.UTF8ToString(module._pw_zstd_error_name(status))).toMatch(/Src size is incorrect/)
    } finally {
      if (input !== 0) module._free(input)
      if (context !== 0) module._pw_zstd_compressor_free(context)
    }
  })

  it("rejects pledged sizes beyond JavaScript's exact integer range", async () => {
    await expect(createStreamingZstdCompressor({ pledgedSize: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(
      /non-negative safe integer/,
    )
  })

  it("accepts concatenated frames and official skippable frames", async () => {
    const first = new TextEncoder().encode("first frame")
    const second = new TextEncoder().encode("second frame")
    const skippable = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 9, 8, 7, 6)
    const stream = join([await compressZstd(first), skippable, await compressZstd(second)])
    expect(await decompressZstd(stream, first.byteLength + second.byteLength)).toStrictEqual(join([first, second]))
  })

  it("accepts an empty frame at a zero output limit", async () => {
    const compressed = await compressZstd(new Uint8Array())
    expect(await decompressZstd(compressed, 0)).toStrictEqual(new Uint8Array())
  })

  it("uses one-shot capacity only when the complete frame content size is known", async () => {
    const module = await instantiateDecoder()
    const source = new Uint8Array(1024).fill(42)
    const [knownSizeFrame, unknownSizeFrame] = await Promise.all([
      compressZstd(source),
      compressWithoutContentSize(source),
    ])

    expect(decompressionCapacity(module, knownSizeFrame, 0xffff_ffff)).toBe(0)
    expect(decompressionCapacity(module, unknownSizeFrame, 0xffff_ffff)).toBe(6)
    expect(await decompressZstd(unknownSizeFrame, source.byteLength)).toStrictEqual(source)
    await expect(decompressZstd(unknownSizeFrame, source.byteLength - 1)).rejects.toThrow(/configured limit/)
  })

  it("rejects truncated streams and output beyond the configured limit", async () => {
    const source = new TextEncoder().encode("bounded output ".repeat(100))
    const compressed = await compressZstd(source)

    const truncated = await createStreamingZstdDecompressor(source.byteLength)
    try {
      truncated.push(compressed.subarray(0, -1))
      expect(() => truncated.finish()).toThrow(/ended before the frame was complete/)
    } finally {
      truncated.free()
    }

    await expect(decompressZstd(compressed.subarray(0, -1), source.byteLength)).rejects.toThrow(
      /ended before the frame was complete/,
    )
    await expect(decompressZstd(compressed, source.byteLength - 1)).rejects.toThrow(/configured limit/)
  })

  it("enforces the output limit across multiple decoder output blocks", async () => {
    const source = new Uint8Array(300_000).fill(42)
    const compressed = await compressZstd(source)

    expect(await decompressZstd(compressed, source.byteLength)).toStrictEqual(source)
    await expect(decompressZstd(compressed, source.byteLength - 1)).rejects.toThrow(/configured limit/)
  })

  it("accepts the recommended 8 MiB window and rejects larger windows for tiny outputs", async () => {
    const source = new TextEncoder().encode("small output with a deliberately oversized window")
    const compressed = await compressWithoutContentSize(source)
    expect(compressed[4] & 0x20).toBe(0)

    compressed[5] = 0x68 // 8 MiB window.
    const restored = await decompressZstd(compressed, source.byteLength)
    expect(restored.byteLength).toBe(source.byteLength)
    expect(restored.findIndex((byte, index) => byte !== source[index])).toBe(-1)

    compressed[5] = 0x70 // 16 MiB window exceeds the cap derived for this tiny output.

    const decompressor = await createStreamingZstdDecompressor(source.byteLength)
    try {
      expect(() => decompressor.push(compressed)).toThrow(/requires too much memory/)
    } finally {
      decompressor.free()
    }
  })
})
