import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import createNanoRQCodec from "../optical/nanorq-codec/nanorq_codec.js"

describe.each(["simd", "scalar"] as const)("NanoRQ arena lifetimes (%s)", (variant) => {
  it.each([
    { length: 8, symbolSize: 8, dependentPackets: 20 },
    { length: 4099, symbolSize: 96, dependentPackets: 0 },
  ])("recovers $length bytes after heap churn and $dependentPackets dependent packets", async (testCase) => {
    const codec = await createNanoRQCodec({
      wasmBinary: readFileSync(`frontend/optical/nanorq-codec/nanorq_codec_${variant}.wasm`),
    })
    const { length, symbolSize, dependentPackets } = testCase
    const source = dependentPackets
      ? Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0)
      : Uint8Array.from({ length }, (_, i) => (i * 31) & 255)
    const encoder = codec._nanorq_encoder_new(length, symbolSize)
    expect(encoder).not.toBe(0)
    let decoder = 0
    let packet = 0
    let output = 0
    const allocations: number[] = []
    try {
      const ptr = codec._nanorq_encoder_source(encoder)
      const stride = codec._nanorq_encoder_source_stride(encoder)
      for (let offset = 0; offset < length; offset += symbolSize) {
        codec.HEAPU8.set(source.subarray(offset, offset + symbolSize), ptr + (offset / symbolSize) * stride)
      }
      expect(codec._nanorq_encoder_prepare(encoder)).toBe(1)
      // Reuse freed preparation arenas before any repair is generated. Stale
      // arena reads must not silently survive on the old allocation contents.
      for (let i = 0; i < 64; i++) {
        const size = [256, 1024, 4096, 16384][i % 4]
        const allocation = codec._nanorq_alloc(size)
        expect(allocation).not.toBe(0)
        allocations.push(allocation)
        codec.HEAPU8.fill(0xa5 ^ i, allocation, allocation + size)
      }
      expect(codec._nanorq_encoder_prepare(encoder)).toBe(1)
      decoder = codec._nanorq_decoder_new(length, symbolSize)
      packet = codec._nanorq_alloc(symbolSize + 4)
      output = codec._nanorq_alloc(length)
      expect(decoder && packet && output).not.toBe(0)
      let dependent = 0
      let complete = false
      for (let sequence = 0; sequence < 20000 && !complete; sequence++) {
        if (!dependentPackets && sequence % 5 === 0) continue
        expect(codec._nanorq_encoder_repair(encoder, sequence, packet, symbolSize + 4)).toBe(1)
        const bytes = codec.HEAPU8.slice(packet, packet + symbolSize + 4)
        const zero = bytes.subarray(4).every((byte) => byte === 0)
        if (dependentPackets && (dependent < dependentPackets ? !zero : zero)) continue
        const input = codec._nanorq_decoder_input(decoder)
        expect(input).not.toBe(0)
        codec.HEAPU8.set(bytes, input)
        const result = codec._nanorq_decoder_commit(decoder, output, length)
        expect(result).toBeGreaterThanOrEqual(0)
        if (dependent < dependentPackets) {
          dependent++
          expect(result).toBe(0)
        }
        complete = result === 1
      }
      expect(dependent).toBe(dependentPackets)
      expect(complete).toBe(true)
      expect(codec.HEAPU8.slice(output, output + length)).toEqual(source)
    } finally {
      for (const allocation of allocations) codec._nanorq_free(allocation)
      codec._nanorq_free(output)
      codec._nanorq_free(packet)
      codec._nanorq_decoder_free(decoder)
      codec._nanorq_encoder_free(encoder)
    }
  })
})
