import { median } from "../benchmark-utils.mjs"
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"

import createNanoRQCodec from "../../frontend/optical/nanorq-codec/nanorq_codec.js"

const root = new URL("../../frontend/optical/nanorq-codec/", import.meta.url)
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ["simd", "scalar"]
const cases = [
  { symbols: 32, symbolSize: 96 },
  { symbols: 96, symbolSize: 480 },
  { symbols: 64, symbolSize: 2928 },
]
const repairCount = 5000
const samples = 5

function makeEncoder(codec, source, symbolSize) {
  const handle = codec._nanorq_encoder_new(source.length, symbolSize)
  if (!handle) throw new Error("Encoder allocation failed")
  try {
    const pointer = codec._nanorq_encoder_source(handle)
    const stride = codec._nanorq_encoder_source_stride(handle)
    if (!pointer || stride < symbolSize) throw new Error("Invalid encoder matrix")
    for (let offset = 0; offset < source.length; offset += symbolSize) {
      codec.HEAPU8.set(source.subarray(offset, offset + symbolSize), pointer + (offset / symbolSize) * stride)
    }
    return handle
  } catch (error) {
    codec._nanorq_encoder_free(handle)
    throw error
  }
}

function prepareEncoder(codec, handle) {
  const start = performance.now()
  if (!codec._nanorq_encoder_prepare(handle)) throw new Error("Encoder preparation failed")
  return performance.now() - start
}

function encodePackets(codec, handle, count, keep) {
  const packetLength = codec._nanorq_encoder_packet_length(handle)
  const pointer = codec._nanorq_alloc(packetLength)
  if (!pointer) throw new Error("Packet allocation failed")
  const packets = keep ? [] : undefined
  try {
    const start = performance.now()
    for (let sequence = 0; sequence < count; sequence++) {
      if (!codec._nanorq_encoder_repair(handle, sequence, pointer, packetLength)) {
        throw new Error(`Repair ${sequence} failed`)
      }
      if (packets) packets.push(codec.HEAPU8.slice(pointer, pointer + packetLength))
    }
    return { elapsed: performance.now() - start, packets }
  } finally {
    codec._nanorq_free(pointer)
  }
}

function recover(codec, source, symbolSize, packets) {
  const decoder = codec._nanorq_decoder_new(source.length, symbolSize)
  if (!decoder) throw new Error("Decoder allocation failed")
  const output = codec._nanorq_alloc(source.length)
  if (!output) {
    codec._nanorq_decoder_free(decoder)
    throw new Error("Output allocation failed")
  }
  try {
    let consumed = 0
    const start = performance.now()
    for (const packet of packets) {
      const input = codec._nanorq_decoder_input(decoder)
      if (!input) throw new Error("Decoder input allocation failed")
      codec.HEAPU8.set(packet, input)
      const result = codec._nanorq_decoder_commit(decoder, output, source.length)
      if (result < 0) throw new Error("Decoder failed")
      consumed++
      if (result > 0) {
        const elapsed = performance.now() - start
        const actual = codec.HEAPU8.subarray(output, output + source.length)
        if (actual.some((value, index) => value !== source[index])) throw new Error("Recovered data mismatch")
        return { elapsed, consumed }
      }
    }
    throw new Error("Insufficient repair packets")
  } finally {
    codec._nanorq_free(output)
    codec._nanorq_decoder_free(decoder)
  }
}

for (const variant of variants) {
  if (!["simd", "scalar"].includes(variant)) throw new Error(`Unknown variant: ${variant}`)
  const wasm = readFileSync(new URL(`nanorq_codec_${variant}.wasm`, root))
  const codec = await createNanoRQCodec({ wasmBinary: wasm })
  for (const { symbols, symbolSize } of cases) {
    const source = Uint8Array.from({ length: symbols * symbolSize }, (_, index) => (index * 73 + 41) & 255)
    const prepareTimes = []
    const repairTimes = []
    const recoveryTimes = []
    let recoveredFrom = 0
    for (let sample = 0; sample < samples; sample++) {
      const encoder = makeEncoder(codec, source, symbolSize)
      try {
        prepareTimes.push(prepareEncoder(codec, encoder))
        repairTimes.push(encodePackets(codec, encoder, repairCount, false).elapsed)
        const packets = encodePackets(codec, encoder, symbols * 3, true).packets.filter((_, index) => index % 5 !== 0)
        const recovery = recover(codec, source, symbolSize, packets)
        recoveryTimes.push(recovery.elapsed)
        recoveredFrom = recovery.consumed
      } finally {
        codec._nanorq_encoder_free(encoder)
      }
    }
    console.log(
      `${variant} K=${symbols} T=${symbolSize}: prepare ${median(prepareTimes).toFixed(2)} ms, ` +
        `repair ${((median(repairTimes) * 1000) / repairCount).toFixed(1)} us/symbol, ` +
        `recover ${median(recoveryTimes).toFixed(2)} ms (${recoveredFrom} packets)`,
    )
  }
}
