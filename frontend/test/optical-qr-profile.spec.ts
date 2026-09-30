import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import { correction, generate, mode, type GenerateOptions, type Mode } from "lean-qr"
import { type OpticalModule } from "../optical/codec/optical_codec.js"
import { initializeNanoRQ, WasmNanoRQQrGenerator } from "../optical/shared/nanorq-runtime.js"
import { OpticalQrFrameEncoder } from "../optical/shared/qr-frame-encoder.js"
import { RaptorQDecoder } from "../optical/shared/fountain.js"
import { inspectFrame } from "../optical/shared/protocol.js"
import { copyQrMonochrome, createMonochromeFrame } from "../optical/shared/monochrome.js"
import { loadOpticalTestCodec, withOpticalInput, decodeTransferQr } from "./optical-codec-test.js"
import { type QrErrorCorrection, TRANSFER_QR_MARGIN, TRANSFER_QR_MASK } from "../optical/shared/qr.js"
import { patternedQr, referenceTransferQr, type ReferenceQrBitmap } from "./qr-reference.js"

interface CarrierVector {
  name: string
  version: number
  ecc: QrErrorCorrection
  payloadHex: string
  modulesHex: string
}

const fixture = JSON.parse(readFileSync("frontend/optical/test-vectors/qr-carrier.json", "utf8")) as {
  format: number
  mask: number
  vectors: CarrierVector[]
}
const codecs = new Map<string, OpticalModule>()

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

beforeAll(async () => {
  await initializeNanoRQ(readFileSync("frontend/optical/nanorq-codec/nanorq_codec_simd.wasm"))
  await Promise.all(
    (["simd", "scalar"] as const).map(async (variant) => {
      codecs.set(variant, await loadOpticalTestCodec(variant))
    }),
  )
})

function independentQr(segment: Mode, options: GenerateOptions = {}): ReferenceQrBitmap {
  const qr = generate(segment, {
    minVersion: 3,
    maxVersion: 3,
    minCorrectionLevel: correction.L,
    maxCorrectionLevel: correction.L,
    mask: 3,
    ...options,
  })
  return patternedQr(qr.size, (x, y) => qr.get(x, y))
}

describe("documented QR carrier profile", () => {
  it.each(["simd", "scalar"] as const)(
    "prefers the intact version copy over a damaged v48-like copy in %s",
    (variant) => {
      const bytes = Uint8Array.of(9, 3, 7, 1)
      const qr = referenceTransferQr(bytes, "L", 40)
      const damaged = patternedQr(qr.size, (x, y) => {
        if (x >= qr.size - 11 && x <= qr.size - 9 && y < 6) {
          const bit = y * 3 + x - (qr.size - 11)
          return (((0x302ad ^ 1) >>> bit) & 1) !== 0
        }
        return qr.get(x, y)
      })
      expect(decodeTransferQr(codecs.get(variant)!, damaged)).toEqual([[[...bytes]], [[...bytes]]])
    },
  )

  it("rejects unsupported or fractional explicit versions before entering WASM", () => {
    const encoder = new WasmNanoRQQrGenerator()
    try {
      for (const version of [0, 41, 47, 49, 1.5, 48.5, NaN, Infinity]) {
        expect(() => encoder.encode(Uint8Array.of(1), "L", version)).toThrow("Invalid QR version")
      }
    } finally {
      encoder.free()
    }
  })

  it("refreshes QR output after WASM memory growth and version changes", async () => {
    const codec = await initializeNanoRQ(readFileSync("frontend/optical/nanorq-codec/nanorq_codec_simd.wasm"))
    const encoder = new WasmNanoRQQrGenerator()
    let allocation = 0
    try {
      const payload = Uint8Array.from({ length: 4143 }, (_, i) => (i * 37) & 255)
      const original = encoder.encode(payload, "L", 48)
      const expected = original.packed.slice()
      expect(encoder.encode(payload, "L", 48).packed).toBe(original.packed)

      allocation = codec._nanorq_alloc(codec.HEAPU8.byteLength)
      expect(allocation).not.toBe(0)
      expect(codec.HEAPU8.buffer).not.toBe(original.packed.buffer)
      const grown = encoder.encode(payload, "L", 48)
      expect(grown.packed.buffer).toBe(codec.HEAPU8.buffer)
      expect(grown.packed).toEqual(expected)

      const small = Uint8Array.of(1, 3, 5)
      expect(encoder.encode(small, "L", 3).packed).toEqual(referenceTransferQr(small, "L", 3).packed)
      expect(encoder.encode(payload, "L", 48).packed).toEqual(expected)
    } finally {
      if (allocation) codec._nanorq_free(allocation)
      encoder.free()
    }
  })

  it.each([
    { index: 0, count: 0, transferId: undefined },
    { index: 1, count: 2, transferId: 0x123456789abcdefn },
  ])("recovers a complete 4143 B/frame transfer for part $index/$count through QR and RaptorQ", (part) => {
    const container = Uint8Array.from({ length: 7000 }, (_, i) => (i * 37 + 11) & 255)
    const encoder = new OpticalQrFrameEncoder({
      container,
      containerTag: 0x1234n,
      part,
      frameBytes: 4143,
      ecc: "L",
    })
    let decoder: RaptorQDecoder | undefined
    try {
      for (let sequence = 0; sequence < encoder.k + 8 && !decoder?.isComplete; sequence++) {
        const encoded = encoder.encode(sequence)
        expect(encoded.size).toBe(209)
        const qr = patternedQr(encoded.size, (x, y) => {
          const index = y * encoded.size + x
          return (encoded.packed[index >> 3] & (1 << (index & 7))) !== 0
        })
        const frame = Uint8Array.from(decodeTransferQr(codecs.get("simd")!, qr)[0][0])
        expect(frame.length).toBeLessThanOrEqual(4143)
        const inspected = inspectFrame(frame)
        expect(inspected.verdict.kind).toBe("ok")
        if (!("frame" in inspected)) throw new Error("The decoded frame is invalid.")
        expect(inspected.frame.header).toMatchObject({ totalLen: container.length, containerTag: 0x1234n, part })
        decoder ??= new RaptorQDecoder(inspected.frame.header.packetLen, container.length)
        decoder.addFrame(inspected.frame.block)
      }
      expect(decoder?.assemble()).toEqual(container)
    } finally {
      decoder?.free()
      encoder.free()
    }
  })

  it("round-trips the exact v48 capacity at every ECC through scalar and SIMD decoders", () => {
    const encoder = new WasmNanoRQQrGenerator()
    try {
      for (const [ecc, capacity] of [
        ["L", 4143],
        ["M", 2953],
        ["Q", 2331],
        ["H", 1450],
      ] as const) {
        const bytes = Uint8Array.from({ length: capacity }, (_, i) => (i * 59 + capacity) & 255)
        const encoded = encoder.encode(bytes, ecc)
        expect(encoded.size).toBe(209)
        const qr = patternedQr(encoded.size, (x, y) => {
          const index = y * encoded.size + x
          return (encoded.packed[index >> 3] & (1 << (index & 7))) !== 0
        })
        for (const variant of ["simd", "scalar"] as const) {
          expect(decodeTransferQr(codecs.get(variant)!, qr), `${ecc}/${variant}`).toEqual([[[...bytes]], [[...bytes]]])
          const mirrored = patternedQr(qr.size, (x, y) => qr.get(y, x))
          expect(decodeTransferQr(codecs.get(variant)!, mirrored), `${ecc}/${variant}/mirrored`).toEqual([
            [[...bytes]],
            [[...bytes]],
          ])
        }
        expect(() => encoder.encode(new Uint8Array(capacity + 1), ecc, 48)).toThrow("Too much data")
        // Force both caches back through the standard layout before the next v48 symbol.
        const standardBytes = Uint8Array.of(1, 3, 5)
        const standard = encoder.encode(standardBytes, "L", 40)
        const reference = referenceTransferQr(standardBytes, "L", 40)
        expect(standard.packed).toEqual(reference.packed)
        for (const codec of codecs.values()) {
          expect(decodeTransferQr(codec, reference)).toEqual([[[...standardBytes]], [[...standardBytes]]])
        }
      }
    } finally {
      encoder.free()
    }
  })

  it.each(["simd", "scalar"] as const)(
    "switches cached layouts across all normal/mirrored versions in %s",
    (variant) => {
      const codec = codecs.get(variant)!
      for (const version of [...Array.from({ length: 40 }, (_, i) => i + 1), 1, 40, 9, 10]) {
        const payload = Uint8Array.from({ length: version + 3 }, (_, i) => (i * 31 + version) & 255)
        const qr = referenceTransferQr(payload, (["L", "M", "Q", "H"] as const)[version % 4], version)
        const mirror = patternedQr(qr.size, (x, y) => qr.get(y, x))
        const cell = qr.size + 2 * TRANSFER_QR_MARGIN
        const pixels = createMonochromeFrame(cell * 2, cell)
        for (const [index, symbol] of [qr, mirror].entries()) {
          copyQrMonochrome(pixels, cell * 2, cell, symbol, TRANSFER_QR_MARGIN, index * cell, 0, 1)
        }
        const symbols = withOpticalInput(codec, pixels, (ptr) =>
          codec.readModuleGridMono1(ptr, cell * 2, cell, version, 2, 1),
        )
        expect(symbols.map((symbol) => [...symbol])).toEqual([[...payload], [...payload]])
      }
    },
  )

  it.each(["simd", "scalar"] as const)("decodes full byte capacity across both count widths in %s", (variant) => {
    for (const [version, length] of [
      [1, 17],
      [9, 230],
      [10, 271],
      [40, 2953],
    ]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 59 + version) & 255)
      expect(decodeTransferQr(codecs.get(variant)!, referenceTransferQr(bytes, "L", version))).toEqual([
        [[...bytes]],
        [[...bytes]],
      ])
    }
  })

  it.each(["simd", "scalar"] as const)(
    "scans dense transitions and SIMD tails at varied pixel scales in %s",
    (variant) => {
      const bytes = Uint8Array.of(1, 3, 5, 7, 9)
      const qr = referenceTransferQr(bytes, "L", 1)
      const codec = codecs.get(variant)!
      for (const scale of [1, 2, 3, 4, 7, 8, 15, 16, 17]) {
        for (const extra of [0, 1, 7, 15]) {
          const width = (qr.size + 8) * scale + extra
          const pixels = new Uint8Array(width * width).fill(255)
          for (let y = 0; y < qr.size; y++) {
            for (let x = 0; x < qr.size; x++) {
              if (!qr.get(x, y)) continue
              for (let dy = 0; dy < scale; dy++) {
                const offset = ((y + 4) * scale + dy) * width + (x + 4) * scale
                pixels.fill(0, offset, offset + scale)
              }
            }
          }
          const symbols = withOpticalInput(codec, pixels, (ptr) => codec.readFullLum(ptr, width, width, 1))
          expect(
            symbols.map((symbol) => [...symbol]),
            `scale=${scale}, extra=${extra}`,
          ).toEqual([[...bytes]])
        }
      }
    },
  )

  it.each(["simd", "scalar"] as const)("unpacks every byte alignment in an eight-cell %s grid", (variant) => {
    const version = 3
    const columns = 8
    const payloads = Array.from({ length: columns }, (_, index) => Uint8Array.of(index + 1, index * 29))
    const codes = payloads.map((payload) => referenceTransferQr(payload, "L", version))
    const cell = codes[0].size + 2 * TRANSFER_QR_MARGIN
    const width = cell * columns
    const pixels = createMonochromeFrame(width, cell)
    codes.forEach((qr, index) => copyQrMonochrome(pixels, width, cell, qr, TRANSFER_QR_MARGIN, index * cell, 0, 1))

    withOpticalInput(codecs.get(variant)!, pixels, (ptr) => {
      const symbols = codecs.get(variant)!.readModuleGridMono1(ptr, width, cell, version, columns, 1)
      expect(symbols.map((symbol) => [...symbol])).toEqual(payloads.map((payload) => [...payload]))
    })
  })

  it.each(["simd", "scalar"] as const)(
    "decodes the fixed transfer profile at every ECC level with the %s codec",
    async (variant) => {
      const levels = ["L", "M", "Q", "H"] as const
      const payloads = levels.map((_, index) =>
        Uint8Array.from({ length: 80 + index * 7 }, (__, offset) => (index * 67 + offset) & 0xff),
      )
      const codes = payloads.map((payload, index) => referenceTransferQr(payload, levels[index], 10))
      const cell = codes[0].size + 2 * TRANSFER_QR_MARGIN
      const width = cell * 2
      const pixels = createMonochromeFrame(width, width)
      codes.forEach((qr, index) =>
        copyQrMonochrome(
          pixels,
          width,
          width,
          qr,
          TRANSFER_QR_MARGIN,
          (index % 2) * cell,
          Math.floor(index / 2) * cell,
          1,
        ),
      )

      const codec = await loadOpticalTestCodec(variant)
      withOpticalInput(codec, pixels, (ptr) => {
        const symbols = codec.readModuleGridMono1(ptr, width, width, 10, 2, 2)
        expect(symbols).toHaveLength(4)
        expect(symbols.map((symbol) => [...symbol])).toEqual(payloads.map((payload) => [...payload]))
      })
    },
  )

  it.each(["simd", "scalar"] as const)(
    "decodes transfer versions across both byte-count widths with the %s codec",
    (variant) => {
      const payload = Uint8Array.of(9, 7, 5, 3, 1)
      for (const version of [1, 9, 10, 40]) {
        const qr = referenceTransferQr(payload, "L", version)
        expect(decodeTransferQr(codecs.get(variant)!, qr)).toEqual([[[...payload]], [[...payload]]])
      }
    },
  )

  it.each(["simd", "scalar"] as const)(
    "retains mirrored and BCH-corrected format handling with the %s codec",
    (variant) => {
      const payload = Uint8Array.of(2, 4, 6, 8)
      const version = 7
      const qr = referenceTransferQr(payload, "Q", version)
      const mirrored = patternedQr(qr.size, (x, y) => qr.get(y, x))
      const damagedFormatModules = new Set([
        "0,8",
        "1,8",
        "2,8",
        `8,${qr.size - 1}`,
        `8,${qr.size - 2}`,
        `8,${qr.size - 3}`,
      ])
      const damaged = patternedQr(qr.size, (x, y) =>
        damagedFormatModules.has(`${x},${y}`) ? !qr.get(x, y) : qr.get(x, y),
      )

      expect(decodeTransferQr(codecs.get(variant)!, mirrored)).toEqual([[[...payload]], [[...payload]]])
      expect(decodeTransferQr(codecs.get(variant)!, damaged)).toEqual([[[...payload]], [[...payload]]])
    },
  )

  it.each(["simd", "scalar"] as const)(
    "corrects damaged data codewords and rejects damage beyond ECC capacity with the %s codec",
    (variant) => {
      const payload = Uint8Array.of(1, 3, 5, 7, 9)
      const qr = referenceTransferQr(payload, "L", 1)
      const flip = (positions: ReadonlySet<string>) =>
        patternedQr(qr.size, (x, y) => (positions.has(`${x},${y}`) ? !qr.get(x, y) : qr.get(x, y)))
      // Version 1-L has seven ECC codewords: two damaged codewords are
      // recoverable, while four distinct damaged codewords exceed its limit.
      const recoverable = flip(new Set(["20,20", "20,16"]))
      const excessive = flip(new Set(["20,20", "20,16", "20,12", "18,20"]))

      expect(decodeTransferQr(codecs.get(variant)!, recoverable)).toEqual([[[...payload]], [[...payload]]])
      expect(decodeTransferQr(codecs.get(variant)!, excessive)).toEqual([[], []])
    },
  )

  it.each(["simd", "scalar"] as const)(
    "decodes a wide camera frame without histogram bucket overflow in %s",
    (variant) => {
      const payload = Uint8Array.of(1, 3, 5, 7, 9)
      const qr = referenceTransferQr(payload, "L", 1)
      // The four histogram sample rows contain exactly 65,536 light pixels;
      // a uint16_t bucket wraps to zero and rejects this valid QR symbol.
      const width = 27339
      const height = 116
      const scale = 4
      const left = Math.floor((width - height) / 2) + 4 * scale
      const top = 4 * scale
      const luminance = new Uint8Array(width * height).fill(244)
      for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
          if (!qr.get(x, y)) continue
          for (let row = 0; row < scale; row++) {
            const offset = (top + y * scale + row) * width + left + x * scale
            luminance.fill(18, offset, offset + scale)
          }
        }
      }
      const decoded = withOpticalInput(codecs.get(variant)!, luminance, (ptr) =>
        codecs.get(variant)!.readFullLum(ptr, width, height, 1),
      )
      expect(decoded.map((bytes) => [...bytes])).toEqual([[...payload]])
    },
  )

  it.each(fixture.vectors)("pins the $name matrix against both independent encoders", (vector) => {
    expect(fixture.format).toBe(1)
    expect(TRANSFER_QR_MASK).toBe(fixture.mask)
    expect(TRANSFER_QR_MARGIN).toBe(4)
    const bytes = fromHex(vector.payloadHex)
    const qr = referenceTransferQr(bytes, vector.ecc, vector.version)
    expect(toHex(qr.packed)).toBe(vector.modulesHex)
    const encoder = new WasmNanoRQQrGenerator()
    try {
      const actual = encoder.encode(bytes, vector.ecc, vector.version)
      expect(actual.size).toBe(17 + 4 * vector.version)
      expect(toHex(actual.packed)).toBe(vector.modulesHex)
    } finally {
      encoder.free()
    }
  })

  it.each(["simd", "scalar"])("decodes the frozen carrier vectors through both %s paths", (variant) => {
    const codec = codecs.get(variant)!
    for (const vector of fixture.vectors) {
      const packed = fromHex(vector.modulesHex)
      const size = 17 + 4 * vector.version
      const qr = patternedQr(size, (x, y) => (packed[(y * size + x) >> 3] & (1 << ((y * size + x) & 7))) !== 0)
      const expected = [Array.from(fromHex(vector.payloadHex))]
      expect(decodeTransferQr(codec, qr)).toEqual([expected, expected])
    }
  })

  it.each(["simd", "scalar"])("rejects non-profile modes, masks and padding through both %s paths", (variant) => {
    const codec = codecs.get(variant)!
    const bytes = fromHex(fixture.vectors[1].payloadHex)
    const wrongLength: Mode = (bits) => {
      bits.push(4, 4)
      bits.push(255, 8)
      bits.push(0, 8)
    }
    const wrongTerminator: Mode = (bits, version) => {
      mode.bytes(bytes)(bits, version)
      bits.push(15, 4)
    }
    const rejected: [string, ReferenceQrBitmap][] = [
      ["numeric mode", independentQr(mode.numeric("1234567890"))],
      ["ECI before bytes", independentQr(mode.multi(mode.eci(26), mode.bytes(bytes)))],
      [
        "two byte segments",
        independentQr(mode.multi(mode.bytes(bytes.subarray(0, 12)), mode.bytes(bytes.subarray(12)))),
      ],
      ["nonzero terminator", independentQr(wrongTerminator)],
      ["truncated byte segment", independentQr(wrongLength)],
      ["nonstandard pad bytes", independentQr(mode.bytes(bytes), { trailer: 0 })],
      ...([0, 1, 2, 4, 5, 6, 7] as const).map((mask): [string, ReferenceQrBitmap] => [
        `mask ${mask}`,
        independentQr(mode.bytes(bytes), { mask }),
      ]),
    ]
    for (const [name, qr] of rejected) expect(decodeTransferQr(codec, qr), name).toEqual([[], []])
  })
})
