import type { XXHashModule } from "./xxhash/xxhash.js"
import {
  allocateWasm,
  createRetryableLoader,
  instantiateEmscriptenModule,
  ReusableWasmInput,
  resolveWasmInitSource,
  type LazyWasmInitSource,
} from "../utils/wasm.js"

let modulePromise: Promise<XXHashModule> | undefined

const initialize = createRetryableLoader(async (source: LazyWasmInitSource) =>
  instantiateEmscriptenModule(await resolveWasmInitSource(source), async () => {
    const { default: createXXHash } = await import("./xxhash/xxhash.js")
    return createXXHash
  }),
)

/** Initialize XXH3 from a Module/promise (production) or bytes (tests/tools). */
export function initializeXXHash(source: LazyWasmInitSource): Promise<void> {
  modulePromise = initialize(source)
  return modulePromise.then(() => undefined)
}

async function xxhashModule(): Promise<XXHashModule> {
  if (!modulePromise) throw new Error("xxHash has not been initialized")
  return modulePromise
}

function validateSize(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("xxHash input size must be an unsigned 32-bit integer.")
  }
}

function allocate(module: XXHashModule, size: number): number {
  return allocateWasm(module, size, "xxHash")
}

function unsigned64(value: bigint): bigint {
  return BigInt.asUintN(64, value)
}

/** Hash one complete byte sequence through official XXH3_64bits(). */
export async function xxh3(bytes: Uint8Array): Promise<bigint> {
  const module = await xxhashModule()
  validateSize(bytes.byteLength)
  if (bytes.byteLength === 0) return unsigned64(module._pw_xxh3_64bits(0, 0))
  const input = allocate(module, bytes.byteLength)
  try {
    module.HEAPU8.set(bytes, input)
    return unsigned64(module._pw_xxh3_64bits(input, bytes.byteLength))
  } finally {
    module._free(input)
  }
}

export interface StreamingXXH3 {
  update(input: Uint8Array): void
  digest(): bigint
  reset(): void
  free(): void
}

class OfficialStreamingXXH3 implements StreamingXXH3 {
  private state: number
  private readonly input: ReusableWasmInput

  constructor(private readonly module: XXHashModule) {
    this.input = new ReusableWasmInput(module, "xxHash")
    this.state = module._pw_xxh3_state_new()
    if (this.state === 0) throw new Error("xxHash: WebAssembly state allocation failed")
  }

  update(bytes: Uint8Array): void {
    if (this.state === 0) throw new Error("xxHash: streaming state has been freed")
    validateSize(bytes.byteLength)
    const status = this.input.withBytes(bytes, (pointer) =>
      this.module._pw_xxh3_state_update(this.state, pointer, bytes.byteLength),
    )
    if (status !== 0) throw new Error("xxHash: streaming update failed")
  }

  digest(): bigint {
    if (this.state === 0) throw new Error("xxHash: streaming state has been freed")
    return unsigned64(this.module._pw_xxh3_state_digest(this.state))
  }

  reset(): void {
    if (this.state === 0) throw new Error("xxHash: streaming state has been freed")
    if (this.module._pw_xxh3_state_reset(this.state) !== 0) throw new Error("xxHash: streaming reset failed")
  }

  free(): void {
    if (this.state === 0) return
    this.module._pw_xxh3_state_free(this.state)
    this.state = 0
    this.input.free()
  }
}

/** Create a state backed by the official XXH3 streaming lifecycle. */
export async function createStreamingXXH3(): Promise<StreamingXXH3> {
  return new OfficialStreamingXXH3(await xxhashModule())
}

/** Hash a synchronous or asynchronous sequence of chunks as one byte stream. */
export async function xxh3Chunks(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<bigint> {
  const hasher = await createStreamingXXH3()
  try {
    for await (const chunk of chunks) hasher.update(chunk)
    return hasher.digest()
  } finally {
    hasher.free()
  }
}

/** Hash one in-memory sequence through bounded streaming updates. */
export async function xxh3Chunked(bytes: Uint8Array, chunkSize: number): Promise<bigint> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("xxHash chunk size must be a positive integer.")
  }
  function* chunks(): Generator<Uint8Array> {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      yield bytes.subarray(offset, offset + chunkSize)
    }
  }
  return await xxh3Chunks(chunks())
}
