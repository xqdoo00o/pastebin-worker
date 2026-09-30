import { benchmarkBytes, median } from "../benchmark-utils.mjs"
import { readFileSync } from "node:fs"
import { Buffer } from "node:buffer"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"

const options = { candidate: resolve(import.meta.dirname, "../../frontend/wasm/zstd"), samples: 9, sizeMiB: 8 }
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i]
  const value = process.argv[i + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  if (flag === "--baseline" || flag === "--candidate") options[flag.slice(2)] = resolve(value)
  else if (flag === "--samples") options.samples = Number(value)
  else if (flag === "--size-mib") options.sizeMiB = Number(value)
  else throw new Error(`Unknown argument: ${flag}`)
}
if (!Number.isInteger(options.samples) || options.samples < 3 || options.samples > 50)
  throw new Error("Invalid samples")
if (!Number.isInteger(options.sizeMiB) || options.sizeMiB < 1 || options.sizeMiB > 64)
  throw new Error("Invalid size-mib")

async function load(root, role, variant) {
  const { default: create } = await import(pathToFileURL(resolve(root, `zstd_${role}.js`)).href)
  const compiled = await WebAssembly.compile(readFileSync(resolve(root, `zstd_${role}_${variant}.wasm`)))
  return create({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports)
      done(instance, compiled)
      return instance.exports
    },
  })
}

function check(codec, status) {
  if (status !== 0) throw new Error(codec.UTF8ToString(codec._pw_zstd_error_name(status)))
}

function allocate(codec, size) {
  const pointer = codec._malloc(size)
  if (!pointer) throw new Error("Benchmark allocation failed")
  return pointer
}

function compress(codec, bytes, knownSize) {
  const context = codec._pw_zstd_compressor_new(0, bytes.length, Number(knownSize))
  if (!context) throw new Error("Compressor allocation failed")
  let input = 0
  try {
    input = allocate(codec, bytes.length)
    codec.HEAPU8.set(bytes, input)
    const chunks = []
    for (const status of [
      () => codec._pw_zstd_compressor_push(context, input, bytes.length),
      () => codec._pw_zstd_compressor_finish(context),
    ]) {
      check(codec, status())
      const pointer = codec._pw_zstd_compressor_output(context)
      chunks.push(codec.HEAPU8.slice(pointer, pointer + codec._pw_zstd_compressor_output_size(context)))
    }
    return Buffer.concat(chunks)
  } finally {
    codec._free(input)
    codec._pw_zstd_compressor_free(context)
  }
}

function prepare(codec, compressed, expected) {
  const input = allocate(codec, compressed.length)
  codec.HEAPU8.set(compressed, input)
  return {
    dispose: () => codec._free(input),
    run(validate = false) {
      const context = codec._pw_zstd_decompressor_new(expected.length * 2)
      if (!context) throw new Error("Decoder allocation failed")
      try {
        const times = []
        // Consecutive frames exercise both growth and reuse of output capacity.
        for (let frame = 0; frame < 2; frame++) {
          const start = performance.now()
          const status = codec._pw_zstd_decompressor_push(context, input, compressed.length)
          times.push(performance.now() - start)
          check(codec, status)
          const size = codec._pw_zstd_decompressor_output_size(context)
          if (size !== expected.length) throw new Error("Wrong decompressed size")
          if (validate) {
            const pointer = codec._pw_zstd_decompressor_output(context)
            if (codec.HEAPU8.subarray(pointer, pointer + size).some((byte, i) => byte !== expected[i])) {
              throw new Error("Decompressed bytes differ")
            }
          }
        }
        check(codec, codec._pw_zstd_decompressor_finish(context))
        return times
      } finally {
        codec._pw_zstd_decompressor_free(context)
      }
    },
  }
}

const encoder = await load(options.candidate, "encoder", "simd")
for (const variant of ["simd", "scalar"]) {
  const candidate = await load(options.candidate, "decoder", variant)
  const baseline = options.baseline ? await load(options.baseline, "decoder", variant) : undefined
  for (const structured of [true, false]) {
    const source = benchmarkBytes(options.sizeMiB * 1024 * 1024, structured ? 65536 : 0)
    for (const knownSize of [true, false]) {
      const compressed = compress(encoder, source, knownSize)
      const cases = [prepare(candidate, compressed, source)]
      if (baseline) cases.push(prepare(baseline, compressed, source))
      const samples = cases.map(() => [[], []])
      try {
        for (const test of cases) {
          test.run(true)
          for (let warm = 0; warm < 4; warm++) test.run()
        }
        for (let sample = 0; sample < options.samples; sample++) {
          const order = cases.map((_, index) => index)
          if (sample % 2) order.reverse()
          for (const index of order) cases[index].run().forEach((ms, frame) => samples[index][frame].push(ms))
        }
        console.log(
          JSON.stringify({
            variant,
            structured,
            knownSize,
            sizeMiB: options.sizeMiB,
            compressedBytes: compressed.length,
            candidateMs: samples[0].map(median),
            ...(baseline
              ? {
                  baselineMs: samples[1].map(median),
                  changePercent: samples[0].map(
                    (values, frame) => (median(values) / median(samples[1][frame]) - 1) * 100,
                  ),
                }
              : {}),
          }),
        )
      } finally {
        for (const test of cases) test.dispose()
      }
    }
  }
}
