import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import createNanoRQCodec from "../optical/nanorq-codec/nanorq_codec.js"
import { referenceTransferQr } from "./qr-reference.js"

describe("NanoRQ fixed-mask QR cache", () => {
  it("encodes the v48 capacity at every ECC in the scalar codec", async () => {
    const codec = await createNanoRQCodec({
      wasmBinary: readFileSync("frontend/optical/nanorq-codec/nanorq_codec_scalar.wasm"),
    })
    const qr = codec._nanorq_qr_new()
    expect(qr).not.toBe(0)
    try {
      const input = codec._nanorq_qr_input(qr)
      for (const [ecc, capacity] of [
        [0, 4143],
        [1, 2953],
        [2, 2331],
        [3, 1450],
      ] as const) {
        const bytes = Uint8Array.from({ length: capacity }, (_, i) => (i * 67 + ecc) & 255)
        codec.HEAPU8.set(bytes, input)
        expect(codec._nanorq_qr_encode(qr, capacity, ecc, 48, 48, 3)).toBe(209)
        codec.HEAPU8.set(new Uint8Array(capacity + 1), input)
        expect(codec._nanorq_qr_encode(qr, capacity + 1, ecc, 48, 48, 3)).toBe(0)
      }
    } finally {
      codec._nanorq_qr_free(qr)
    }
  })

  it.each(["simd", "scalar"] as const)(
    "matches independent QR output for every version/ECC in %s",
    async (variant) => {
      const codec = await createNanoRQCodec({
        wasmBinary: readFileSync(`frontend/optical/nanorq-codec/nanorq_codec_${variant}.wasm`),
      })
      const qr = codec._nanorq_qr_new()
      expect(qr).not.toBe(0)
      try {
        // Reuse a single handle while crossing every RS degree and block layout.
        for (let version = 1; version <= 40; version++) {
          for (const [code, ecc] of (["L", "M", "Q", "H"] as const).entries()) {
            for (const salt of [0, 137]) {
              const bytes = Uint8Array.from({ length: version * 3 + 4 }, (_, i) => (i * 73 + salt) & 255)
              const expected = referenceTransferQr(bytes, ecc, version)
              codec.HEAPU8.set(bytes, codec._nanorq_qr_input(qr))
              expect(codec._nanorq_qr_encode(qr, bytes.length, code, version, version, 3)).toBe(expected.size)
              const packed = codec._nanorq_qr_packed(qr)
              expect(codec.HEAPU8.slice(packed, packed + expected.packed.length)).toEqual(expected.packed)
            }
          }
        }
      } finally {
        codec._nanorq_qr_free(qr)
      }
    },
    15000,
  )

  it.each(["simd", "scalar"] as const)("rebuilds on descending versions and ECC changes in %s", async (variant) => {
    const wasm = readFileSync(`frontend/optical/nanorq-codec/nanorq_codec_${variant}.wasm`)
    const codec = await createNanoRQCodec({ wasmBinary: wasm })
    const qr = codec._nanorq_qr_new()
    expect(qr).not.toBe(0)
    const input = codec._nanorq_qr_input(qr)
    const packed = codec._nanorq_qr_packed(qr)
    try {
      const cases = [
        { version: 40, ecc: "L" as const, code: 0, length: 2953 },
        { version: 15, ecc: "L" as const, code: 0, length: 500 },
        { version: 15, ecc: "Q" as const, code: 2, length: 200 },
        { version: 1, ecc: "L" as const, code: 0, length: 10 },
      ]
      for (const [index, testCase] of cases.entries()) {
        const bytes = Uint8Array.from({ length: testCase.length }, (_, offset) => (offset * 73 + index * 41) & 255)
        const expected = referenceTransferQr(bytes, testCase.ecc, testCase.version)
        codec.HEAPU8.set(bytes, input)
        const size = codec._nanorq_qr_encode(qr, bytes.length, testCase.code, testCase.version, testCase.version, 3)
        expect(size).toBe(expected.size)
        expect(codec.HEAPU8.slice(packed, packed + expected.packed.length)).toEqual(expected.packed)
      }
    } finally {
      codec._nanorq_qr_free(qr)
    }
  })
})
