const params = new URLSearchParams(location.search)
const sizeMiB = Number(params.get("sizeMiB") || 128)
const samples = Number(params.get("samples") || 5)
const baselineRoot = params.get("baseline") || "/candidate"
const candidateRoot = params.get("candidate") || "/candidate"
const chunkBytes = 4 * 1024 * 1024

function sourceBytes(length, compressible) {
  const bytes = new Uint8Array(length)
  let state = 0x9e3779b9
  const block = new Uint8Array(64 * 1024)
  for (let index = 0; index < block.length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    block[index] = state
  }
  for (let offset = 0; offset < length; offset += block.length) {
    const target = bytes.subarray(offset, Math.min(length, offset + block.length))
    if (compressible) {
      target.set(block.subarray(0, target.length))
      // Preserve repeated structure while changing a few fields per block,
      // roughly modelling logs, source trees and document collections.
      const view = new DataView(bytes.buffer, offset, target.length)
      if (target.length >= 8) view.setBigUint64(0, BigInt(offset), true)
    } else {
      for (let index = 0; index < target.length; index++) {
        state ^= state << 13
        state ^= state >>> 17
        state ^= state << 5
        target[index] = state
      }
    }
  }
  return bytes
}

async function instantiate(factoryUrl, wasmUrl) {
  const [{ default: createModule }, compiled] = await Promise.all([
    import(factoryUrl),
    WebAssembly.compileStreaming(fetch(wasmUrl)),
  ])
  return await createModule({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(compiled, imports)
      done(instance, compiled)
      return instance.exports
    },
  })
}

function output(module, context) {
  const size = module._pw_zstd_compressor_output_size(context)
  const pointer = module._pw_zstd_compressor_output(context)
  return size === 0 ? new Uint8Array() : module.HEAPU8.slice(pointer, pointer + size)
}

function check(module, status) {
  if (status !== 0) throw new Error(`zstd status ${status}: ${module.UTF8ToString(module._pw_zstd_error_name(status))}`)
}

function compress(module, source, retainOutput) {
  const context = module._pw_zstd_compressor_new(0, source.byteLength, 1)
  const input = module._malloc(chunkBytes)
  if (!context || !input) throw new Error("Could not allocate benchmark compressor")
  const chunks = []
  let byteLength = 0
  try {
    for (let offset = 0; offset < source.length; offset += chunkBytes) {
      const chunk = source.subarray(offset, Math.min(source.length, offset + chunkBytes))
      module.HEAPU8.set(chunk, input)
      check(module, module._pw_zstd_compressor_push(context, input, chunk.length))
      const current = output(module, context)
      byteLength += current.length
      if (retainOutput && current.length) chunks.push(current)
    }
    check(module, module._pw_zstd_compressor_finish(context))
    const final = output(module, context)
    byteLength += final.length
    if (retainOutput && final.length) chunks.push(final)
    if (!retainOutput) return { byteLength }
    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return { byteLength, bytes }
  } finally {
    module._free(input)
    module._pw_zstd_compressor_free(context)
  }
}

function decompress(module, compressed, expectedSize) {
  const input = module._malloc(compressed.length)
  const output = module._malloc(expectedSize)
  const written = module._malloc(4)
  if (!input || !output || !written) throw new Error("Could not allocate benchmark decoder")
  try {
    module.HEAPU8.set(compressed, input)
    check(module, module._pw_zstd_decompress(input, compressed.length, output, expectedSize, written))
    const length = new DataView(module.HEAPU8.buffer).getUint32(written, true)
    return module.HEAPU8.slice(output, output + length)
  } finally {
    module._free(written)
    module._free(output)
    module._free(input)
  }
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function timedCompress(module, source) {
  const started = performance.now()
  const compressedBytes = compress(module, source, false).byteLength
  return { milliseconds: performance.now() - started, compressedBytes }
}

async function measurePair(baseline, threaded, source) {
  // Warm both implementations in both orders before measuring. Measurements
  // remain paired and alternate order so CPU frequency and scheduler drift do
  // not systematically favour the second implementation.
  compress(baseline, source, false)
  compress(threaded, source, false)
  compress(threaded, source, false)
  compress(baseline, source, false)
  const elapsed = { baseline: [], threaded: [] }
  let compressedBytes = { baseline: 0, threaded: 0 }
  for (let sample = 0; sample < samples; sample++) {
    const order = sample % 2 === 0 ? ["baseline", "threaded"] : ["threaded", "baseline"]
    for (const implementation of order) {
      const result = timedCompress(implementation === "baseline" ? baseline : threaded, source)
      elapsed[implementation].push(result.milliseconds)
      compressedBytes[implementation] = result.compressedBytes
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  const result = {}
  for (const implementation of ["baseline", "threaded"]) {
    const milliseconds = median(elapsed[implementation])
    result[implementation] = {
      milliseconds,
      mibPerSecond: sizeMiB / (milliseconds / 1000),
      compressedBytes: compressedBytes[implementation],
    }
  }
  result.speedup = median(elapsed.baseline.map((milliseconds, index) => milliseconds / elapsed.threaded[index]))
  return result
}

async function main() {
  if (!crossOriginIsolated) throw new Error("Benchmark page is not cross-origin isolated")
  const [baseline, threaded, decoder] = await Promise.all([
    instantiate(`${baselineRoot}/zstd_encoder.js`, `${baselineRoot}/zstd_encoder_simd.wasm`),
    instantiate(`${candidateRoot}/zstd_encoder_threaded.js`, `${candidateRoot}/zstd_encoder_threaded.wasm`),
    instantiate(`${candidateRoot}/zstd_decoder.js`, `${candidateRoot}/zstd_decoder_simd.wasm`),
  ])
  const cases = []
  for (const compressible of [true, false]) {
    const name = compressible ? "structured" : "incompressible"
    const source = sourceBytes(sizeMiB * 1024 * 1024, compressible)
    const measured = await measurePair(baseline, threaded, source)
    for (const [implementation, module] of [
      ["baseline", baseline],
      ["threaded", threaded],
    ]) {
      const encoded = compress(module, source, true).bytes
      const decoded = decompress(decoder, encoded, source.length)
      if (!equalBytes(source, decoded)) throw new Error(`${name} ${implementation} round trip failed`)
    }
    cases.push({
      name,
      ...measured,
    })
  }
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    sizeMiB,
    samples,
    cases,
  }
}

const result = document.querySelector("#result")
try {
  result.textContent = JSON.stringify(await main())
} catch (error) {
  result.textContent = JSON.stringify({ error: error instanceof Error ? error.stack || error.message : String(error) })
}
