import { describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { unzlibSync } from "fflate"
import OpticalCodec from "../optical/codec/optical_codec.js"
import {
  copyQrMonochrome,
  createMonochromeRgbaLookup,
  createMonochromeFrame,
  expandMonochromeRgba,
  qrMonochrome,
} from "../optical/shared/monochrome.js"
import { gridDims, qrVersion, TRANSFER_QR_MARGIN } from "../optical/shared/qr.js"
import { OPTICAL_APNG_FORMAT_VERSION, type OpticalApngMetadata } from "../optical/shared/apng-format.js"
import { APNG_QR_SCALE, ApngEncoder } from "../optical/send/apng.js"
import { inflateApngFrameInto, streamApngFrames } from "../optical/receive/apng.js"
import { patternedQr, referenceTransferQr, type ReferenceQrBitmap } from "./qr-reference.js"

interface ApngChunk {
  type: string
  data: Uint8Array
}

const TEST_APNG_METADATA: OpticalApngMetadata = {
  format: OPTICAL_APNG_FORMAT_VERSION,
  scale: 1,
  grid: 1,
  qr: 1,
}
const TEST_APNG_SIZE = 21 + 2 * TRANSFER_QR_MARGIN

function testApngFrame(fill = 0xff, scale = 1): Uint8Array {
  const width = TEST_APNG_SIZE * scale
  return new Uint8Array(Math.ceil(width / 8) * width).fill(fill)
}

function filteredMonochrome(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = Math.ceil(width / 8)
  const filtered = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row++)
    filtered.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  return filtered
}

/** Split a PNG/APNG byte sequence into its chunks. */
function apngChunks(bytes: Uint8Array): ApngChunk[] {
  const chunks: ApngChunk[] = []
  let offset = 8
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    const length = view.getUint32(0)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += length + 12
  }
  return chunks
}

/** Reassemble PNG chunks with zeroed CRCs; the decoder does not check them. */
function rebuildApng(signature: Uint8Array, chunks: ApngChunk[]): Uint8Array {
  const body: Uint8Array[] = [signature]
  for (const { type, data } of chunks) {
    const name = new TextEncoder().encode(type)
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(name, 4)
    out.set(data, 8)
    body.push(out)
  }
  return new Uint8Array(body.reduce<number[]>((all, part) => all.concat([...part]), []))
}

async function inflateFrame(
  compressed: Blob | Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  metadata: OpticalApngMetadata = TEST_APNG_METADATA,
): Promise<Uint8Array> {
  const stride = Math.ceil(width / metadata.scale / 8)
  const packed = new Uint8Array(stride * (height / metadata.scale))
  await inflateApngFrameInto(compressed, width, height, packed, metadata)
  return packed
}

function referenceMonochrome(qr: ReferenceQrBitmap, margin: number): Uint8Array {
  const width = qr.size + 2 * margin
  const stride = Math.ceil(width / 8)
  const output = createMonochromeFrame(width, width)
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.get(x, y)) output[(y + margin) * stride + ((x + margin) >> 3)] &= ~(0x80 >> ((x + margin) & 7))
    }
  }
  return output
}

describe("optical APNG encoder", () => {
  it("maps the nine-code mode to a 3×3 grid", () => {
    expect(gridDims(9)).toEqual({ cols: 3, rows: 3 })
  })

  it("renders Nayuki's packed matrix across unaligned rows and recycles output", () => {
    const qr = referenceTransferQr(Uint8Array.of(1, 2, 3, 4), "L")
    const image = qrMonochrome(qr, TRANSFER_QR_MARGIN)
    const reusable = new Uint8Array(image.data.length)
    const recycled = qrMonochrome(qr, TRANSFER_QR_MARGIN, reusable)

    expect(recycled.data).toBe(reusable)
    expect(recycled.data).toEqual(image.data)
    expect(image.data).toEqual(referenceMonochrome(qr, TRANSFER_QR_MARGIN))
  })

  it("packs live QR cells to one bit per pixel and expands into reusable RGBA storage", () => {
    const qr = patternedQr(2, (x, y) => x === y)
    const image = qrMonochrome(qr, 1)
    const rgba = new Uint32Array(16)
    const lookup = createMonochromeRgbaLookup(0x11111111, 0xeeeeeeee)
    expandMonochromeRgba(image.data, image.width, image.height, rgba, lookup)

    expect([...image.data]).toEqual([0xff, 0xbf, 0xdf, 0xff])
    expect([...rgba]).toEqual([
      0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee, 0x11111111, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee,
      0xeeeeeeee, 0x11111111, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee, 0xeeeeeeee,
    ])
  })

  it("scales QR modules directly into packed 1-bit pixels", () => {
    const target = createMonochromeFrame(8, 8)
    const qr = patternedQr(2, (x) => x === 0)
    copyQrMonochrome(target, 8, 8, qr, 0, 0, 0, APNG_QR_SCALE)

    expect([...target]).toEqual(Array(8).fill(0x0f))
  })

  it("overwrites stale pixels around an unaligned scaled QR cell", () => {
    const width = 23
    const height = 17
    const stride = Math.ceil(width / 8)
    const target = new Uint8Array(stride * height) // deliberately all black
    const expected = new Uint8Array(target.length)
    const qr = patternedQr(3, (x, y) => (x + y) % 2 === 0)
    const margin = 1
    const scale = 2
    const targetX = 3
    const targetY = 2

    const writeExpected = (x: number, y: number, black: boolean) => {
      const offset = y * stride + (x >> 3)
      const mask = 0x80 >> (x & 7)
      if (black) expected[offset] &= ~mask
      else expected[offset] |= mask
    }
    const sourceSize = qr.size + 2 * margin
    for (let sourceY = 0; sourceY < sourceSize; sourceY++) {
      for (let sourceX = 0; sourceX < sourceSize; sourceX++) {
        const qrX = sourceX - margin
        const qrY = sourceY - margin
        const black = qrX >= 0 && qrX < qr.size && qrY >= 0 && qrY < qr.size && qr.get(qrX, qrY)
        for (let repeatY = 0; repeatY < scale; repeatY++) {
          for (let repeatX = 0; repeatX < scale; repeatX++) {
            writeExpected(targetX + sourceX * scale + repeatX, targetY + sourceY * scale + repeatY, black)
          }
        }
      }
    }

    copyQrMonochrome(target, width, height, qr, margin, targetX, targetY, scale)
    expect(target).toEqual(expected)

    const onePixel = new Uint8Array(1)
    copyQrMonochrome(
      onePixel,
      8,
      1,
      patternedQr(1, () => false),
      0,
      3,
      0,
      1,
    )
    expect(onePixel[0]).toBe(0x10)
  })

  it("writes a looping 1-bit indexed animation with valid APNG sequencing", async () => {
    const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 2, 20, TEST_APNG_METADATA)
    const pixels = testApngFrame()
    pixels[0] = 0x7f
    await encoder.addFrame(pixels)
    pixels[0] = 0xbf
    await encoder.addFrame(pixels)
    const bytes = new Uint8Array(await encoder.finish().arrayBuffer())
    const chunks: { type: string; data: Uint8Array; crcSource: Uint8Array; crc: number }[] = []
    let offset = 8
    while (offset < bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
      const length = view.getUint32(0)
      const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
      chunks.push({
        type,
        data: bytes.subarray(offset + 8, offset + 8 + length),
        crcSource: bytes.subarray(offset + 4, offset + 8 + length),
        crc: view.getUint32(8 + length),
      })
      offset += length + 12
    }

    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(chunks.map(({ type }) => type)).toEqual([
      "IHDR",
      "PLTE",
      "iTXt",
      "acTL",
      "fcTL",
      "IDAT",
      "fcTL",
      "fdAT",
      "IEND",
    ])
    expect(chunks[0].data[8]).toBe(1)
    expect(chunks[0].data[9]).toBe(3)
    expect(chunks[1].type).toBe("PLTE")
    expect([...chunks[1].data]).toEqual([0x00, 0x00, 0x00, 0xff, 0xff, 0xff])
    expect(new TextDecoder().decode(chunks[2].data.subarray(0, 11))).toBe("qr-transfer")
    expect([...chunks[2].data.subarray(11, 16)]).toEqual([0, 0, 0, 0, 0])
    expect(JSON.parse(new TextDecoder().decode(chunks[2].data.subarray(16)))).toEqual(TEST_APNG_METADATA)
    expect(new DataView(chunks[3].data.buffer, chunks[3].data.byteOffset).getUint32(0)).toBe(2)
    expect(new DataView(chunks[3].data.buffer, chunks[3].data.byteOffset).getUint32(4)).toBe(0)
    expect(
      chunks
        .filter(({ type }) => type === "fcTL")
        .map(({ data }) => new DataView(data.buffer, data.byteOffset).getUint32(0)),
    ).toEqual([0, 1])
    const frameData = chunks.find(({ type }) => type === "fdAT")!.data
    expect(new DataView(frameData.buffer, frameData.byteOffset).getUint32(0)).toBe(2)
    expect(chunks[chunks.length - 1]).toMatchObject({ type: "IEND", crc: 0xae426082 })

    const crcTable = new Uint32Array(256)
    for (let value = 0; value < crcTable.length; value++) {
      let crc = value
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
      crcTable[value] = crc >>> 0
    }
    for (const pngChunk of chunks) {
      let crc = 0xffffffff
      for (const byte of pngChunk.crcSource) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
      expect(pngChunk.crc).toBe((crc ^ 0xffffffff) >>> 0)
    }

    const inflated = new Uint8Array(
      await new Response(
        new ReadableStream<BufferSource>({
          start(controller) {
            controller.enqueue(Uint8Array.from(chunks.find(({ type }) => type === "IDAT")!.data))
            controller.close()
          },
        }).pipeThrough(new DecompressionStream("deflate")),
      ).arrayBuffer(),
    )
    expect(inflated).toEqual(
      filteredMonochrome(
        Uint8Array.from(pixels, (_, index) => (index === 0 ? 0x7f : 0xff)),
        TEST_APNG_SIZE,
        TEST_APNG_SIZE,
      ),
    )

    const inflatedFrame = new Uint8Array(
      await new Response(
        new ReadableStream<BufferSource>({
          start(controller) {
            controller.enqueue(Uint8Array.from(frameData.subarray(4)))
            controller.close()
          },
        }).pipeThrough(new DecompressionStream("deflate")),
      ).arrayBuffer(),
    )
    expect(inflatedFrame).toEqual(filteredMonochrome(pixels, TEST_APNG_SIZE, TEST_APNG_SIZE))
  })

  it("falls back to fflate when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined)
    try {
      const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 1, 20, TEST_APNG_METADATA)
      const pixels = testApngFrame()
      pixels[0] = 0x7f
      await encoder.addFrame(pixels)
      const bytes = new Uint8Array(await encoder.finish().arrayBuffer())
      const imageData = apngChunks(bytes).find(({ type }) => type === "IDAT")?.data

      expect(imageData).toBeDefined()
      expect(unzlibSync(imageData!)).toEqual(filteredMonochrome(pixels, TEST_APNG_SIZE, TEST_APNG_SIZE))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("rejects incomplete animations", () => {
    expect(() => new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 2, 10, TEST_APNG_METADATA).finish()).toThrow(
      "expected 2 frames",
    )
  })

  it("streams and inflates exported frames into packed pixels", async () => {
    const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 2, 20, TEST_APNG_METADATA)
    const first = testApngFrame()
    const second = testApngFrame()
    first[0] = 0x7f
    second[0] = 0xbf
    await encoder.addFrame(first)
    await encoder.addFrame(second)
    const frames: Uint8Array[] = []
    const result = await streamApngFrames(encoder.finish(), async ({ compressed, width, height, metadata }) => {
      frames.push(await inflateFrame(compressed, width, height, metadata))
    })

    expect(result).toEqual({
      width: TEST_APNG_SIZE,
      height: TEST_APNG_SIZE,
      frames: 2,
      metadata: TEST_APNG_METADATA,
    })
    expect(frames).toEqual([first, second])
  })

  it("keeps in-memory APNG parsing and frame inflation free of Blobs", async () => {
    const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 1, 20, TEST_APNG_METADATA)
    const pixels = testApngFrame()
    pixels[0] = 0x7f
    await encoder.addFrame(pixels)
    const bytes = new Uint8Array(await encoder.finish().arrayBuffer())
    let compressedFrame: Uint8Array<ArrayBuffer> | undefined

    await streamApngFrames(bytes, async ({ compressed, width, height, metadata }) => {
      expect(compressed).toBeInstanceOf(Uint8Array)
      compressedFrame = compressed as Uint8Array<ArrayBuffer>
      expect(await inflateFrame(compressedFrame, width, height, metadata)).toEqual(pixels)
    })

    expect(compressedFrame).toBeDefined()
  })

  it("reads QR metadata once and downsamples replicated monochrome pixels while inflating", async () => {
    const metadata: OpticalApngMetadata = { ...TEST_APNG_METADATA, scale: 4 }
    const size = TEST_APNG_SIZE * metadata.scale
    const pixels = testApngFrame(0xff, metadata.scale)
    for (let row = 0; row < metadata.scale; row++) pixels[row * Math.ceil(size / 8)] = 0x0f
    const encoder = new ApngEncoder(size, size, 1, 20, metadata)
    await encoder.addFrame(pixels)
    const frames: Uint8Array[] = []
    const result = await streamApngFrames(encoder.finish(), async ({ compressed, width, height, metadata }) => {
      frames.push(await inflateFrame(compressed, width, height, metadata))
    })

    expect(result).toEqual({ width: size, height: size, frames: 1, metadata })
    expect(frames).toHaveLength(1)
    expect(frames[0][0]).toBe(0x7f)
  })

  it("requires valid atomic QR metadata", async () => {
    const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 1, 20, TEST_APNG_METADATA)
    await encoder.addFrame(testApngFrame())
    const bytes = new Uint8Array(await encoder.finish().arrayBuffer())
    const chunks = apngChunks(bytes)
    const metadataIndex = chunks.findIndex(({ type }) => type === "iTXt")
    const signature = bytes.subarray(0, 8)

    await expect(
      streamApngFrames(
        new Blob([
          Uint8Array.from(
            rebuildApng(
              signature,
              chunks.filter((_, index) => index !== metadataIndex),
            ),
          ),
        ]),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("missing its QR metadata")

    const invalid = chunks.map((pngChunk, index) =>
      index === metadataIndex
        ? {
            ...pngChunk,
            data: new TextEncoder().encode('qr-transfer\0\0\0\0\0{"format":1,"scale":9,"grid":1,"qr":1}'),
          }
        : pngChunk,
    )
    await expect(
      streamApngFrames(new Blob([Uint8Array.from(rebuildApng(signature, invalid))]), () => Promise.resolve()),
    ).rejects.toThrow("QR metadata is invalid")

    const mismatched = chunks.map((pngChunk, index) =>
      index === metadataIndex
        ? {
            ...pngChunk,
            data: new TextEncoder().encode('qr-transfer\0\0\0\0\0{"format":1,"scale":1,"grid":2,"qr":1}'),
          }
        : pngChunk,
    )
    await expect(
      streamApngFrames(new Blob([Uint8Array.from(rebuildApng(signature, mismatched))]), () => Promise.resolve()),
    ).rejects.toThrow("QR metadata does not match its dimensions")
  })

  it("rejects APNG files with a missing or mismatched palette", async () => {
    const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 1, 20, TEST_APNG_METADATA)
    await encoder.addFrame(testApngFrame(0x00))
    const bytes = new Uint8Array(await encoder.finish().arrayBuffer())
    const chunks = apngChunks(bytes)
    const plteIndex = chunks.findIndex(({ type }) => type === "PLTE")
    expect(plteIndex).toBeGreaterThan(-1)
    const signature = bytes.subarray(0, 8)

    await expect(
      streamApngFrames(
        new Blob([
          Uint8Array.from(
            rebuildApng(
              signature,
              chunks.filter((_, index) => index !== plteIndex),
            ),
          ),
        ]),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("missing its black/white palette")

    const mismatched = chunks.map((chunk, index) =>
      index === plteIndex
        ? { ...chunk, data: Uint8Array.from(chunk.data).map((value) => (value === 0 ? 1 : value)) }
        : chunk,
    )
    await expect(
      streamApngFrames(new Blob([Uint8Array.from(rebuildApng(signature, mismatched))]), () => Promise.resolve()),
    ).rejects.toThrow("does not match the expected black/white palette")
  })

  it.each(["simd", "scalar"] as const)(
    "keeps an exported 3×3 QR grid readable by the %s receiver codec",
    async (variant) => {
      const payloads = Array.from({ length: 9 }, (_, index) => Uint8Array.of(index + 1, 2, 3, 4, 5))
      const codes = payloads.map((payload) => referenceTransferQr(payload, "L"))
      const cell = codes[0].size + 2 * TRANSFER_QR_MARGIN
      const width = cell * APNG_QR_SCALE * 3
      const pixels = createMonochromeFrame(width, width)
      codes.forEach((qr, index) =>
        copyQrMonochrome(
          pixels,
          width,
          width,
          qr,
          TRANSFER_QR_MARGIN,
          (index % 3) * cell * APNG_QR_SCALE,
          Math.floor(index / 3) * cell * APNG_QR_SCALE,
          APNG_QR_SCALE,
        ),
      )
      const metadata: OpticalApngMetadata = {
        format: OPTICAL_APNG_FORMAT_VERSION,
        scale: APNG_QR_SCALE,
        grid: 9,
        qr: qrVersion(codes[0]),
      }
      const encoder = new ApngEncoder(width, width, 1, 20, metadata)
      await encoder.addFrame(pixels)
      const wasm = await WebAssembly.compile(await readFile(`frontend/optical/codec/optical_codec_${variant}.wasm`))
      const codec = await OpticalCodec({
        instantiateWasm(imports, done) {
          const instance = new WebAssembly.Instance(wasm, imports)
          done(instance, wasm)
          return instance.exports
        },
      })
      await streamApngFrames(encoder.finish(), async ({ compressed, width: decodedWidth, height, metadata }) => {
        const packed = await inflateFrame(compressed, decodedWidth, height, metadata)
        const ptr = codec._malloc(packed.length)
        codec.HEAPU8.set(packed, ptr)
        const symbols = codec.readModuleGridMono1(
          ptr,
          decodedWidth / metadata.scale,
          height / metadata.scale,
          metadata.qr,
          3,
          3,
        )
        expect(symbols).toHaveLength(9)
        expect(symbols.map((symbol) => [...symbol]).sort((left, right) => left[0] - right[0])).toEqual(
          payloads.map((payload) => [...payload]),
        )
        codec._free(ptr)
      })
    },
  )

  it("decodes warm-tinted optical pixels through RGBA and BGRX camera fallbacks", async () => {
    const payload = Uint8Array.of(9, 8, 7, 6, 5)
    const qr = referenceTransferQr(payload, "L")
    const width = (qr.size + 2 * TRANSFER_QR_MARGIN) * APNG_QR_SCALE
    const packed = createMonochromeFrame(width, width)
    copyQrMonochrome(packed, width, width, qr, TRANSFER_QR_MARGIN, 0, 0, APNG_QR_SCALE)

    // Uint32 pixels are native little-endian RGBA bytes. Keep substantial
    // green-channel contrast while simulating a warm display/camera cast.
    const rgbaWords = new Uint32Array(width * width)
    expandMonochromeRgba(packed, width, width, rgbaWords, createMonochromeRgbaLookup(0xff04123c, 0xff96d2fa))
    const rgba = new Uint8Array(rgbaWords.buffer)
    const bgrx = rgba.slice()
    for (let offset = 0; offset < bgrx.length; offset += 4) {
      ;[bgrx[offset], bgrx[offset + 2]] = [bgrx[offset + 2], bgrx[offset]]
    }

    const wasm = await WebAssembly.compile(await readFile("frontend/optical/codec/optical_codec_simd.wasm"))
    const codec = await OpticalCodec({
      instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(wasm, imports)
        done(instance, wasm)
        return instance.exports
      },
    })
    const ptr = codec._malloc(rgba.length)
    try {
      for (const pixels of [rgba, bgrx]) {
        codec.HEAPU8.set(pixels, ptr)
        const symbols =
          pixels === rgba ? codec.readFull(ptr, width, width, 1) : codec.readFullBGRX(ptr, width, width, 1)
        expect(symbols).toHaveLength(1)
        expect(symbols[0]).toEqual(payload)
      }
    } finally {
      codec._free(ptr)
    }
  })

  it("protects the reusable filter buffer from concurrent frame writes", async () => {
    const encoder = new ApngEncoder(TEST_APNG_SIZE, TEST_APNG_SIZE, 2, 20, TEST_APNG_METADATA)
    const first = encoder.addFrame(testApngFrame(0x7f))

    await expect(encoder.addFrame(testApngFrame(0xbf))).rejects.toThrow("sequentially")
    await first
    await encoder.addFrame(testApngFrame(0xbf))
    expect(encoder.finish()).toBeInstanceOf(Blob)
  })
})
