import { readFileSync } from "node:fs"
import { compressZstdForTest } from "./transfer-codec-test.js"
import { beforeAll, describe, expect, it, vi } from "vitest"
import createZstdDecoder, { type ZstdDecoderModule } from "../wasm/zstd/zstd_decoder.js"
import createZstdEncoder, { type ZstdEncoderModule } from "../wasm/zstd/zstd_encoder.js"
import {
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

async function instantiateDecoder(variant: "simd" | "scalar" = "simd"): Promise<ZstdDecoderModule> {
  const compiled = await WebAssembly.compile(readFileSync(`frontend/wasm/zstd/zstd_decoder_${variant}.wasm`))
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
  it("stops a chunk iterator safely when its decoder is freed between blocks", async () => {
    const compressed = await compressZstdForTest(new Uint8Array(1024 * 1024).fill(9))
    const decoder = await createStreamingZstdDecompressor(1024 * 1024)
    const chunks = decoder.pushChunks(compressed)
    try {
      const first = chunks.next()
      expect(first.done).toBe(false)
      if (first.done) throw new Error("Expected a decompressed block")
      decoder.free()
      expect(() => chunks.next()).toThrow("decoder has been freed")
      expect(first.value.every((byte) => byte === 9)).toBe(true)
    } finally {
      chunks.return?.(undefined)
      decoder.free()
    }
  })

  it("bounds high-ratio output and preserves chunks across subsequent decoder calls", async () => {
    const source = new Uint8Array(16 * 1024 * 1024 + 7).fill(42)
    const compressed = await compressZstdForTest(source)
    expect(compressed.length).toBeLessThan(4096)
    const decoder = await createStreamingZstdDecompressor(source.length)
    const chunks: Uint8Array[] = []
    try {
      for (const chunk of decoder.pushChunks(compressed)) {
        expect(chunk.length).toBeLessThanOrEqual(128 * 1024)
        chunks.push(chunk)
      }
      decoder.finish()
    } finally {
      decoder.free()
    }
    expect(chunks.length).toBeGreaterThan(100)
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(source.length)
    expect(chunks.every((chunk) => chunk.every((byte) => byte === 42))).toBe(true)
    const whole = await decompressZstd(compressed, source.length)
    expect(whole.length).toBe(source.length)
    expect(whole.every((byte) => byte === 42)).toBe(true)
  })

  it("drains bounded output across byte boundaries and concatenated frames", async () => {
    const source = new Uint8Array(256 * 1024).fill(9)
    const frame = await compressWithoutContentSize(source)
    const compressed = join([frame, frame])
    const decoder = await createStreamingZstdDecompressor(source.length * 2)
    let size = 0
    try {
      for (const byte of compressed) {
        for (const chunk of decoder.pushChunks(Uint8Array.of(byte))) {
          expect(chunk.every((value) => value === 9)).toBe(true)
          size += chunk.length
        }
      }
      decoder.finish()
      expect(size).toBe(source.length * 2)
    } finally {
      decoder.free()
    }
    for (const limit of [source.length - 1, source.length]) {
      const limited = await createStreamingZstdDecompressor(limit)
      try {
        if (limit < source.length) expect(() => Array.from(limited.pushChunks(frame))).toThrow(/configured limit/)
        else {
          Array.from(limited.pushChunks(frame.subarray(0, frame.length - 1)))
          expect(() => limited.finish()).toThrow(/ended before/)
        }
      } finally {
        limited.free()
      }
    }
  })

  it("stages unknown-size input only once, including failed decompression", async () => {
    const source = new Uint8Array(1048576 + 7).fill(42)
    const compressed = await compressWithoutContentSize(source)
    for (const limit of [source.length, source.length - 1]) {
      const copies = vi.spyOn(Uint8Array.prototype, "set")
      try {
        if (limit === source.length) {
          const output = await decompressZstd(compressed, limit)
          expect(output.length).toBe(source.length)
          expect(output.every((byte) => byte === 42)).toBe(true)
        } else {
          await expect(decompressZstd(compressed, limit)).rejects.toThrow(/configured limit/)
        }
        expect(copies.mock.calls.filter(([input]) => input === compressed)).toHaveLength(1)
      } finally {
        copies.mockRestore()
      }
    }
  })

  it.each(["simd", "scalar"] as const)(
    "bounds reused output space across consecutive frames in %s",
    async (variant) => {
      const module = await instantiateDecoder(variant)
      const first = new Uint8Array(1048576 + 7).fill(42)
      const second = new Uint8Array(262144 + 23).fill(19)
      const frames = [await compressWithoutContentSize(first), await compressZstdForTest(second)]
      const total = first.length + second.length
      const input = module._malloc(Math.max(...frames.map((frame) => frame.length)))
      expect(input).not.toBe(0)
      try {
        for (const limit of [total, total - 1, 0xffff_ffff]) {
          const context = module._pw_zstd_decompressor_new(limit)
          expect(context).not.toBe(0)
          try {
            for (const [index, frame] of frames.entries()) {
              module.HEAPU8.set(frame, input)
              const status = module._pw_zstd_decompressor_push(context, input, frame.length)
              if (index === 1 && limit === total - 1) {
                expect(status).toBe(3)
                break
              }
              expect(status).toBe(0)
              const expected = index === 0 ? first : second
              const pointer = module._pw_zstd_decompressor_output(context)
              const size = module._pw_zstd_decompressor_output_size(context)
              expect(size).toBe(expected.length)
              expect(module.HEAPU8.subarray(pointer, pointer + size).every((byte) => byte === expected[0])).toBe(true)
            }
            if (limit !== total - 1) expect(module._pw_zstd_decompressor_finish(context)).toBe(0)
          } finally {
            module._pw_zstd_decompressor_free(context)
          }
        }
      } finally {
        module._free(input)
      }
    },
  )

  it("uses zstd's library-default compression level", async () => {
    expect(ZSTD_LEVEL).toBe(0)
    const source = new TextEncoder().encode("default compression level ".repeat(100))
    expect(await compressZstdForTest(source)).toStrictEqual(await compressZstdForTest(source, 0))
  })

  it("retains level 4 and rejects compression levels excluded from the WASM build", async () => {
    const source = new TextEncoder().encode("bounded compression level ".repeat(100))
    const restored = await decompressZstd(await compressZstdForTest(source, ZSTD_MAX_LEVEL), source.byteLength)
    expect(restored.byteLength).toBe(source.byteLength)
    expect(restored.findIndex((byte, index) => byte !== source[index])).toBe(-1)
    await expect(compressZstdForTest(source, ZSTD_MAX_LEVEL + 1)).rejects.toThrow(/integer from -131072 through 4/)
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
    const stream = join([await compressZstdForTest(first), skippable, await compressZstdForTest(second)])
    expect(await decompressZstd(stream, first.byteLength + second.byteLength)).toStrictEqual(join([first, second]))
  })

  it("accepts an empty frame at a zero output limit", async () => {
    const compressed = await compressZstdForTest(new Uint8Array())
    expect(await decompressZstd(compressed, 0)).toStrictEqual(new Uint8Array())
  })

  it("uses one-shot capacity only when the complete frame content size is known", async () => {
    const module = await instantiateDecoder()
    const source = new Uint8Array(1024).fill(42)
    const [knownSizeFrame, unknownSizeFrame] = await Promise.all([
      compressZstdForTest(source),
      compressWithoutContentSize(source),
    ])

    expect(decompressionCapacity(module, knownSizeFrame, 0xffff_ffff)).toBe(0)
    expect(decompressionCapacity(module, unknownSizeFrame, 0xffff_ffff)).toBe(6)
    expect(await decompressZstd(unknownSizeFrame, source.byteLength)).toStrictEqual(source)
    await expect(decompressZstd(unknownSizeFrame, source.byteLength - 1)).rejects.toThrow(/configured limit/)
  })

  it("rejects truncated streams and output beyond the configured limit", async () => {
    const source = new TextEncoder().encode("bounded output ".repeat(100))
    const compressed = await compressZstdForTest(source)

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
    const compressed = await compressZstdForTest(source)

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
