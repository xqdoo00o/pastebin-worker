// Shared zstd runtime backed by the official Meta zstd C library compiled with
// Emscripten. Loading lives in zstd-loader.ts so workers initialized from a
// shared WebAssembly.Module do not bundle or fetch their own WASM assets.

import type { ZstdDecoderModule } from "./zstd/zstd_decoder.js"
import type { ZstdEncoderModule } from "./zstd/zstd_encoder.js"
import {
  allocateWasm,
  configuredWasmVariant,
  createRetryableLoader,
  instantiateEmscriptenModule,
  ReusableWasmInput,
  resolveWasmInitSource,
  type LazyWasmInitSource,
  type WasmInitInput,
  type WasmMemoryModule,
} from "../utils/wasm.js"

/** Use zstd's library-default compression level across application paths. */
export const ZSTD_LEVEL = 0
/** Highest compression level retained in the size-optimized WASM build. */
export const ZSTD_MAX_LEVEL = 4
/** Lowest negative acceleration level accepted by zstd 1.5.7. */
const ZSTD_MIN_LEVEL = -131_072

const UINT32_MAX = 0xffff_ffff
/** Internal C status indicating that the frame lacks a practical one-shot size bound. */
const PW_ZSTD_STREAMING_REQUIRED = 6
let encoderPromise: Promise<ZstdEncoderModule> | undefined
let decoderPromise: Promise<ZstdDecoderModule> | undefined

interface ZstdModuleBase extends WasmMemoryModule {
  HEAPU8: Uint8Array
  UTF8ToString(pointer: number): string
  _pw_zstd_error_name(error: number): number
}

function validateUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer.`)
  }
}

function validateSafeSize(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`)
  }
}

function validateCompressionLevel(level: number): void {
  if (!Number.isInteger(level) || level < ZSTD_MIN_LEVEL || level > ZSTD_MAX_LEVEL) {
    throw new RangeError(`zstd compression level must be an integer from ${ZSTD_MIN_LEVEL} through ${ZSTD_MAX_LEVEL}.`)
  }
}

function instantiateEncoder(moduleOrBytes: WasmInitInput): Promise<ZstdEncoderModule> {
  const compiled =
    moduleOrBytes instanceof WebAssembly.Module ? Promise.resolve(moduleOrBytes) : WebAssembly.compile(moduleOrBytes)
  return compiled.then((module) =>
    instantiateEmscriptenModule(module, async () => {
      // Pthread modules import their shared memory; single-threaded modules
      // export private memory. Detect that ABI distinction so callers still
      // pass only one structured-cloned WebAssembly.Module.
      const threaded =
        configuredWasmVariant === "auto" && WebAssembly.Module.imports(module).some((entry) => entry.kind === "memory")
      return threaded
        ? (await import("./zstd/zstd_encoder_threaded.js")).default
        : (await import("./zstd/zstd_encoder.js")).default
    }),
  )
}

function instantiateDecoder(moduleOrBytes: WasmInitInput): Promise<ZstdDecoderModule> {
  return instantiateEmscriptenModule(moduleOrBytes, async () => {
    const { default: createZstdDecoder } = await import("./zstd/zstd_decoder.js")
    return createZstdDecoder
  })
}

const initializeEncoder = createRetryableLoader(async (source: LazyWasmInitSource) =>
  instantiateEncoder(await resolveWasmInitSource(source)),
)
const initializeDecoder = createRetryableLoader(async (source: LazyWasmInitSource) =>
  instantiateDecoder(await resolveWasmInitSource(source)),
)

/** Initialize an encoder from a Module/promise (production) or bytes (tests/tools). */
export function initializeZstdEncoder(source: LazyWasmInitSource): Promise<void> {
  encoderPromise = initializeEncoder(source)
  return encoderPromise.then(() => undefined)
}

/** Initialize a decoder from a Module/promise (production) or bytes (tests/tools). */
export function initializeZstdDecoder(source: LazyWasmInitSource): Promise<void> {
  decoderPromise = initializeDecoder(source)
  return decoderPromise.then(() => undefined)
}

async function encoder(): Promise<ZstdEncoderModule> {
  if (!encoderPromise) throw new Error("zstd encoder has not been initialized")
  return encoderPromise
}

async function decoder(): Promise<ZstdDecoderModule> {
  if (!decoderPromise) throw new Error("zstd decoder has not been initialized")
  return decoderPromise
}

function codecError(module: ZstdModuleBase, status: number): Error {
  return new Error(`zstd codec: ${module.UTF8ToString(module._pw_zstd_error_name(status))}`)
}

function checkStatus(module: ZstdModuleBase, status: number): void {
  if (status !== 0) throw codecError(module, status)
}

function copyOutput(module: ZstdModuleBase, pointer: number, size: number): Uint8Array {
  if (size === 0) return new Uint8Array()
  if (pointer === 0 || pointer + size > module.HEAPU8.byteLength) {
    throw new Error("zstd codec: invalid WebAssembly output")
  }
  return module.HEAPU8.slice(pointer, pointer + size)
}

/** Compress a whole buffer into one standard zstd frame. */
export async function compressZstd(bytes: Uint8Array, level: number = ZSTD_LEVEL): Promise<Uint8Array> {
  validateCompressionLevel(level)
  const module = await encoder()
  validateUint32(bytes.byteLength, "zstd input size")
  const outputCapacity = module._pw_zstd_compress_bound(bytes.byteLength)
  if (outputCapacity === 0) throw new RangeError("zstd input is too large to compress in WebAssembly.")

  let input = 0
  let output = 0
  let written = 0
  try {
    input = allocateWasm(module, bytes.byteLength, "zstd codec")
    output = allocateWasm(module, outputCapacity, "zstd codec")
    written = allocateWasm(module, Uint32Array.BYTES_PER_ELEMENT, "zstd codec")
    module.HEAPU8.set(bytes, input)
    checkStatus(module, module._pw_zstd_compress(input, bytes.byteLength, output, outputCapacity, level, written))
    const outputSize = new DataView(module.HEAPU8.buffer).getUint32(written, true)
    return copyOutput(module, output, outputSize)
  } finally {
    if (written !== 0) module._free(written)
    if (output !== 0) module._free(output)
    if (input !== 0) module._free(input)
  }
}

export interface StreamingCompressor {
  push(input: Uint8Array): Uint8Array
  finish(): Uint8Array
  free(): void
}

export interface StreamingDecompressor {
  push(input: Uint8Array): Uint8Array
  finish(): void
  free(): void
}

export interface StreamingZstdCompressorOptions {
  level?: number
  /** Exact total number of bytes that will be pushed into this frame. */
  pledgedSize?: number
}

class OfficialStreamingCompressor implements StreamingCompressor {
  private context: number
  private readonly input: ReusableWasmInput

  constructor(
    private readonly module: ZstdEncoderModule,
    level: number,
    pledgedSize: number | undefined,
  ) {
    this.input = new ReusableWasmInput(module, "zstd codec")
    this.context = module._pw_zstd_compressor_new(level, pledgedSize ?? 0, pledgedSize === undefined ? 0 : 1)
    if (this.context === 0) throw new Error("zstd codec: WebAssembly context allocation failed")
  }

  push(input: Uint8Array): Uint8Array {
    validateUint32(input.byteLength, "zstd input size")
    return this.input.withBytes(input, (pointer) => {
      checkStatus(this.module, this.module._pw_zstd_compressor_push(this.context, pointer, input.byteLength))
      return this.output()
    })
  }

  finish(): Uint8Array {
    checkStatus(this.module, this.module._pw_zstd_compressor_finish(this.context))
    return this.output()
  }

  free(): void {
    if (this.context === 0) return
    this.module._pw_zstd_compressor_free(this.context)
    this.context = 0
    this.input.free()
  }

  private output(): Uint8Array {
    return copyOutput(
      this.module,
      this.module._pw_zstd_compressor_output(this.context),
      this.module._pw_zstd_compressor_output_size(this.context),
    )
  }
}

class OfficialStreamingDecompressor implements StreamingDecompressor {
  private context: number
  private readonly input: ReusableWasmInput

  constructor(
    private readonly module: ZstdDecoderModule,
    maxBytes: number,
  ) {
    this.input = new ReusableWasmInput(module, "zstd codec")
    this.context = module._pw_zstd_decompressor_new(maxBytes)
    if (this.context === 0) throw new Error("zstd codec: WebAssembly context allocation failed")
  }

  push(input: Uint8Array): Uint8Array {
    validateUint32(input.byteLength, "zstd input size")
    return this.input.withBytes(input, (pointer) => {
      checkStatus(this.module, this.module._pw_zstd_decompressor_push(this.context, pointer, input.byteLength))
      return this.output()
    })
  }

  finish(): void {
    checkStatus(this.module, this.module._pw_zstd_decompressor_finish(this.context))
  }

  free(): void {
    if (this.context === 0) return
    this.module._pw_zstd_decompressor_free(this.context)
    this.context = 0
    this.input.free()
  }

  private output(): Uint8Array {
    return copyOutput(
      this.module,
      this.module._pw_zstd_decompressor_output(this.context),
      this.module._pw_zstd_decompressor_output_size(this.context),
    )
  }
}

/** Create an incremental encoder for one standard zstd frame. */
export async function createStreamingZstdCompressor(
  levelOrOptions: number | StreamingZstdCompressorOptions = ZSTD_LEVEL,
): Promise<StreamingCompressor> {
  const level = typeof levelOrOptions === "number" ? levelOrOptions : (levelOrOptions.level ?? ZSTD_LEVEL)
  const pledgedSize = typeof levelOrOptions === "number" ? undefined : levelOrOptions.pledgedSize
  validateCompressionLevel(level)
  if (pledgedSize !== undefined) validateSafeSize(pledgedSize, "pledged zstd input size")
  return new OfficialStreamingCompressor(await encoder(), level, pledgedSize)
}

/** Create an incremental decoder with a hard total output ceiling. */
export async function createStreamingZstdDecompressor(maxBytes: number): Promise<StreamingDecompressor> {
  validateUint32(maxBytes, "maximum decompressed size")
  return new OfficialStreamingDecompressor(await decoder(), maxBytes)
}

/** Decompress one or more concatenated zstd frames with a hard output ceiling. */
export async function decompressZstd(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  validateUint32(bytes.byteLength, "zstd input size")
  validateUint32(maxBytes, "maximum decompressed size")
  const module = await decoder()
  const direct = tryDecompressZstd(module, bytes, maxBytes)
  if (direct !== undefined) return direct

  const decompressor = new OfficialStreamingDecompressor(module, maxBytes)
  try {
    const pushed = decompressor.push(bytes)
    decompressor.finish()
    return pushed
  } finally {
    decompressor.free()
  }
}

function tryDecompressZstd(module: ZstdDecoderModule, bytes: Uint8Array, maxBytes: number): Uint8Array | undefined {
  let input = 0
  let capacityPointer = 0
  let output = 0
  let written = 0
  try {
    input = allocateWasm(module, bytes.byteLength, "zstd codec")
    capacityPointer = allocateWasm(module, Uint32Array.BYTES_PER_ELEMENT, "zstd codec")
    module.HEAPU8.set(bytes, input)
    const capacityStatus = module._pw_zstd_decompress_capacity(input, bytes.byteLength, maxBytes, capacityPointer)
    if (capacityStatus === PW_ZSTD_STREAMING_REQUIRED) return undefined
    checkStatus(module, capacityStatus)

    const outputCapacity = new DataView(module.HEAPU8.buffer).getUint32(capacityPointer, true)
    output = allocateWasm(module, outputCapacity, "zstd codec")
    written = allocateWasm(module, Uint32Array.BYTES_PER_ELEMENT, "zstd codec")
    checkStatus(module, module._pw_zstd_decompress(input, bytes.byteLength, output, outputCapacity, written))
    const outputSize = new DataView(module.HEAPU8.buffer).getUint32(written, true)
    if (outputSize > outputCapacity || outputSize > maxBytes) {
      throw new Error("zstd codec: invalid WebAssembly output")
    }
    return copyOutput(module, output, outputSize)
  } finally {
    if (written !== 0) module._free(written)
    if (output !== 0) module._free(output)
    if (capacityPointer !== 0) module._free(capacityPointer)
    if (input !== 0) module._free(input)
  }
}
