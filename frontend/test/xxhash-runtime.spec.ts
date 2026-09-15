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

function directHash(module: XXHashModule, bytes: Uint8Array): bigint {
  const pointer = module._malloc(bytes.byteLength)
  try {
    module.HEAPU8.set(bytes, pointer)
    return BigInt.asUintN(64, module._pw_xxh3_64bits(pointer, bytes.byteLength))
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
  })
})
