import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import createXXHash, { type XXHashModule } from "../wasm/xxhash/xxhash.js"
import { createStreamingXXH3, initializeXXHash, xxh3, xxh3Chunked, xxh3Chunks } from "../wasm/xxhash-runtime.js"

const hello = new TextEncoder().encode("hello")

async function instantiateVariant(variant: "simd" | "scalar"): Promise<XXHashModule> {
  const compiled = await WebAssembly.compile(readFileSync(`frontend/wasm/xxhash/xxhash_${variant}.wasm`))
  return await createXXHash({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports)
      done(instance, compiled)
      return instance.exports
    },
  })
}

function directHash(module: XXHashModule, bytes: Uint8Array, offset = 0): bigint {
  const pointer = module._malloc(bytes.byteLength + offset + 1)
  try {
    module.HEAPU8.set(bytes, pointer + offset)
    return BigInt.asUintN(64, module._pw_xxh3_64bits(pointer + offset, bytes.byteLength))
  } finally {
    module._free(pointer)
  }
}

beforeAll(() => initializeXXHash(readFileSync("frontend/wasm/xxhash/xxhash_simd.wasm")))

describe("official XXH3 WebAssembly runtime", () => {
  it("pins the official XXH3-64 value", async () => {
    await expect(xxh3(hello)).resolves.toBe(0x9555e8555c62dcfdn)
  })

  it("makes the official streaming API match one-shot hashing", async () => {
    const hasher = await createStreamingXXH3()
    try {
      hasher.update(hello.subarray(0, 2))
      hasher.update(hello.subarray(2))
      expect(hasher.digest()).toBe(await xxh3(hello))
    } finally {
      hasher.free()
    }
  })

  it("resets one streaming state for independent hashes", async () => {
    const world = new TextEncoder().encode("world")
    const hasher = await createStreamingXXH3()
    try {
      hasher.update(hello)
      expect(hasher.digest()).toBe(await xxh3(hello))
      hasher.reset()
      hasher.update(world)
      expect(hasher.digest()).toBe(await xxh3(world))
    } finally {
      hasher.free()
    }
  })

  it("hashes synchronous, asynchronous, and bounded chunk sequences identically", async () => {
    const chunks = [hello.subarray(0, 2), hello.subarray(2)]
    async function* asyncChunks() {
      for (const chunk of chunks) {
        await Promise.resolve()
        yield chunk
      }
    }

    const expected = await xxh3(hello)
    await expect(xxh3Chunks(chunks)).resolves.toBe(expected)
    await expect(xxh3Chunks(asyncChunks())).resolves.toBe(expected)
    await expect(xxh3Chunked(hello, 2)).resolves.toBe(expected)
  })

  it("keeps SIMD and scalar builds bit-identical", async () => {
    const [simd, scalar] = await Promise.all([instantiateVariant("simd"), instantiateVariant("scalar")])
    expect(directHash(simd, hello)).toBe(0x9555e8555c62dcfdn)
    expect(directHash(scalar, hello)).toBe(0x9555e8555c62dcfdn)
    for (const length of [
      0, 1, 3, 4, 8, 9, 16, 17, 63, 64, 65, 128, 129, 239, 240, 241, 255, 256, 257, 1023, 1024, 1025, 65536, 1048576,
    ]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 73 + (i >>> 8) * 41) & 255)
      const expected = directHash(scalar, bytes)
      for (const offset of [0, 1, 7, 15]) {
        expect(directHash(simd, bytes, offset), `SIMD length=${length}, offset=${offset}`).toBe(expected)
        expect(directHash(scalar, bytes, offset), `scalar length=${length}, offset=${offset}`).toBe(expected)
      }
    }
  })

  it.each(["simd", "scalar"] as const)("keeps %s streaming tails, digest and reset consistent", async (variant) => {
    const module = await instantiateVariant(variant)
    const bytes = Uint8Array.from({ length: 65537 }, (_, i) => (i * 59 + (i >>> 8) * 17) & 255)
    const expected = directHash(module, bytes)
    const state = module._pw_xxh3_state_new()
    const allocation = module._malloc(bytes.length + 1)
    expect(state).not.toBe(0)
    expect(allocation).not.toBe(0)
    const input = allocation + 1
    try {
      for (const chunkSize of [1, 7, 16, 63, 64, 65, 240, 241, 256, 1024, 4093]) {
        expect(module._pw_xxh3_state_reset(state)).toBe(0)
        expect(module._pw_xxh3_state_update(state, 0, 0)).toBe(0)
        expect(BigInt.asUintN(64, module._pw_xxh3_state_digest(state))).toBe(directHash(module, new Uint8Array()))
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          const chunk = bytes.subarray(offset, offset + chunkSize)
          module.HEAPU8.set(chunk, input)
          const status = module._pw_xxh3_state_update(state, input, chunk.length)
          if (status !== 0) throw new Error(`XXH3 update failed at ${offset}: ${status}`)
          if (offset === 0) {
            // Digest must preserve the state so later updates still work.
            expect(BigInt.asUintN(64, module._pw_xxh3_state_digest(state))).toBe(directHash(module, chunk))
          }
        }
        expect(BigInt.asUintN(64, module._pw_xxh3_state_digest(state)), `chunkSize=${chunkSize}`).toBe(expected)
      }
    } finally {
      module._free(allocation)
      module._pw_xxh3_state_free(state)
    }
  })
})
