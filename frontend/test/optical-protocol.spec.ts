import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it, vi } from "vitest"
import createNanoRQCodec, { type NanoRQCodecModule } from "../optical/nanorq-codec/nanorq_codec.js"
import { expectedTransferVerdict, RaptorQDecoder, RaptorQEncoder } from "../optical/shared/fountain.js"
import { initializeNanoRQ } from "../optical/shared/nanorq-runtime.js"
import { RAPTORQ_PAYLOAD_ID_BYTES } from "../optical/shared/wire.js"
import { initializeZstdDecoder, initializeZstdEncoder } from "../wasm/zstd-runtime.js"
import { initializeXXHash, xxh3 } from "../wasm/xxhash-runtime.js"
import { STREAMING_FILE_READ_CHUNK_BYTES } from "../../shared/constants.js"
import { prepareOpticalTransfer } from "../optical/send/prepared-transfer.js"
import { OpticalQrFrameEncoder } from "../optical/shared/qr-frame-encoder.js"
import { referenceTransferQr } from "./qr-reference.js"
import { estimateTransferProgress, expectedRaptorQOverhead } from "../optical/shared/progress.js"
import {
  frameVerdictMessage,
  frameHeaderLength,
  getXXH3,
  isPrecompressedType,
  inspectFrame,
  MAX_FILE_BYTES,
  MAX_PART_COUNT,
  MAX_TRANSFER_BYTES,
  MULTIPART_HEADER_LEN,
  packTransferPayloadFromSource,
  packFrame,
  packFrameInto,
  STANDALONE_HEADER_LEN,
  symbolLength,
  streamIdentity,
  unpackFile,
  WIRE_VERSION,
  type FrameHeader,
  type PackedOpticalFile,
  type PackTransferPayloadOptions,
} from "../optical/shared/protocol.js"
import { arrayBufferByteSource } from "../utils/byteSource.js"

const FRAME_BYTES = 2953
const STANDALONE_PART = { index: 0, count: 0, transferId: undefined } as const

function classifyFrame(bytes: Uint8Array) {
  return inspectFrame(bytes).verdict
}

function parseFrame(bytes: Uint8Array) {
  const inspected = inspectFrame(bytes)
  return "frame" in inspected ? inspected.frame : null
}

beforeAll(async () => {
  const wasm = readFileSync("frontend/optical/nanorq-codec/nanorq_codec_simd.wasm")
  await initializeNanoRQ(wasm)
  // Load the zstd codec straight from disk so protocol calls never fetch.
  await Promise.all([
    initializeZstdEncoder(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm")),
    initializeZstdDecoder(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm")),
    initializeXXHash(readFileSync("frontend/wasm/xxhash/xxhash_simd.wasm")),
  ])
})

function goldenFrame(): Uint8Array {
  return packFrame(
    {
      totalLen: 24,
      containerTag: 0x0123456789abcdefn,
      part: STANDALONE_PART,
    },
    Uint8Array.of(0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8),
  )
}

function withByte(offset: number, value: number): Uint8Array {
  const frame = goldenFrame()
  frame[offset] = value
  return frame
}

function noise(length: number, seed: number): Uint8Array {
  const output = new Uint8Array(length)
  let state = seed
  for (let index = 0; index < output.length; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    output[index] = state & 0xff
  }
  return output
}

async function prepareParts(
  name: string,
  type: string,
  bytes: Uint8Array,
  partPayloadSize = MAX_FILE_BYTES,
): Promise<PackedOpticalFile[]> {
  const transfer = await prepareOpticalTransfer(
    { name, type, data: bytes.slice().buffer },
    { partPayloadSize, opfsThreshold: Number.MAX_SAFE_INTEGER },
  )
  try {
    return await Promise.all(Array.from({ length: transfer.summary.partCount }, (_, index) => transfer.getPart(index)))
  } finally {
    await transfer.cleanup()
  }
}

type TestPartOptions = Pick<PackTransferPayloadOptions, "index" | "count" | "transferId">

async function packedFile(
  name: string,
  type: string,
  bytes: Uint8Array,
  part?: TestPartOptions,
): Promise<PackedOpticalFile> {
  if (!part) return (await prepareParts(name, type, bytes))[0]
  const data = bytes.slice().buffer
  const source = arrayBufferByteSource(data)
  return await packTransferPayloadFromSource(name, type, source, 0, source.size, {
    compression: "none",
    originalSize: source.size,
    ...part,
  })
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function raptorPacket(sequence: number, k: number, fill = 0): Uint8Array {
  const esi = k + sequence
  return Uint8Array.of(0, esi >>> 16, esi >>> 8, esi, ...new Uint8Array(8).fill(fill))
}

describe("optical transfer protocol", () => {
  it("pins the complete XXH3-64 container tag byte order", async () => {
    expect(await getXXH3(new TextEncoder().encode("hello"))).toBe(0x9555e8555c62dcfdn)
  })

  it("packs and verifies file metadata and contents", async () => {
    const packed = await packedFile("folder/example.txt", "text/plain", new TextEncoder().encode("camera payload"))
    const recovered = await unpackFile(packed.container, packed.part)

    expect(recovered.name).toBe("example.txt")
    expect(recovered.type).toBe("text/plain")
    expect(new TextDecoder().decode(recovered.bytes)).toBe("camera payload")
    expect(await getXXH3(packed.container)).toBe(packed.containerTag)
    expect([...packed.container.subarray(0, 4)]).toEqual([0x44, 0x43, 0x46, 0x35])
  })

  it("strips control characters and unsafe relative names from transferred filenames", async () => {
    const source = Uint8Array.of(1)

    const named = await packedFile("folder/\0bad\n.txt", "text/plain", source)
    const relative = await packedFile("../\0", "", source)
    expect((await unpackFile(named.container, named.part)).name).toBe("bad.txt")
    expect((await unpackFile(relative.container, relative.part)).name).toBe("transfer.bin")
  })

  it("covers DCF5 metadata and payload with the container tag", async () => {
    const packed = await packedFile("name.txt", "text/plain", new TextEncoder().encode("camera payload"))
    const offsets = [4, 17, 17 + "name.txt".length, packed.container.length - 1]

    for (const offset of offsets) {
      const corrupted = packed.container.slice()
      corrupted[offset] ^= 1
      expect(await getXXH3(corrupted)).not.toBe(packed.containerTag)
    }
  })

  it("uses zstd only when it reduces the optical payload and recovers the original bytes", async () => {
    const source = new TextEncoder().encode("camera payload with repeated text\n".repeat(4_000))
    const packed = await packedFile("notes.txt", "text/plain", source)
    const recovered = await unpackFile(packed.container, packed.part)

    expect(packed.compression).toBe("zstd")
    expect(packed.transmittedSize).toBeLessThan(source.length / 10)
    expect(recovered.compression).toBe("zstd")
    expect(new TextDecoder().decode(recovered.bytes)).toBe(new TextDecoder().decode(source))
    expect(await getXXH3(packed.container)).toBe(packed.containerTag)
  })

  it("runs the lazy decoder readiness hook only for a zstd container", async () => {
    const ensureZstdReady = vi.fn(() => Promise.resolve())
    const compressed = await packedFile(
      "notes.txt",
      "text/plain",
      new TextEncoder().encode("lazy decoder readiness\n".repeat(4_000)),
    )
    const uncompressed = await packedFile("photo.jpg", "image/jpeg", noise(4096, 12))

    await unpackFile(compressed.container, compressed.part, ensureZstdReady)
    expect(ensureZstdReady).toHaveBeenCalledOnce()
    await unpackFile(uncompressed.container, uncompressed.part, ensureZstdReady)
    expect(ensureZstdReady).toHaveBeenCalledOnce()
  })

  it("keeps precompressed media verbatim", async () => {
    const source = Uint8Array.from({ length: 4096 }, (_, index) => (index * 97) & 0xff)
    const packed = await packedFile("photo.jpg", "image/jpeg", source)

    expect(isPrecompressedType("image/jpeg")).toBe(true)
    expect(packed.compression).toBe("none")
    expect(packed.transmittedSize).toBe(source.length)
    expect((await unpackFile(packed.container, packed.part)).bytes).toEqual(source)
  })

  it("discards zstd output when incompressible bytes would make the transfer larger", async () => {
    const packed = await packedFile("noise.bin", "application/octet-stream", noise(4096, 0x12345678))

    expect(packed.compression).toBe("none")
    expect(packed.transmittedSize).toBe(4096)
  })

  it("infers the media type from the extension when the sender reports none", async () => {
    const archive = await packedFile("archive.7z", "", noise(4096, 7))
    expect(archive.compression).toBe("none")
    expect((await unpackFile(archive.container, archive.part)).type).toBe("application/x-7z-compressed")

    const text = new TextEncoder().encode("repeated text\n".repeat(2_000))
    const notes = await packedFile("notes.txt", "", text)
    expect(notes.compression).toBe("zstd")
    const recovered = await unpackFile(notes.container, notes.part)
    expect(recovered.type).toBe("text/plain")
    expect(new TextDecoder().decode(recovered.bytes)).toBe(new TextDecoder().decode(text))
  })

  it("keeps a compressible file in one part when zstd fits the part limit", async () => {
    const text = new TextEncoder().encode("repeated line\n".repeat(20_000))
    const parts = await prepareParts("notes.txt", "text/plain", text, 2000)

    expect(parts).toHaveLength(1)
    expect(parts[0].part).toEqual({ index: 0, count: 0, transferId: undefined })
    expect(parts[0].compression).toBe("zstd")
    const recovered = await unpackFile(parts[0].container, parts[0].part)
    expect(new TextDecoder().decode(recovered.bytes)).toBe(new TextDecoder().decode(text))
  })

  it("still splits an incompressible file that exceeds the part size", async () => {
    const source = noise(5000, 0xabc)
    const parts = await prepareParts("noise.bin", "application/octet-stream", source, 2000)

    expect(parts).toHaveLength(3)
    expect(new Set(parts.map((part) => part.part.count))).toEqual(new Set([2]))
    expect(parts.every((part) => part.compression === "none")).toBe(true)
  })

  it("applies the same metadata bounds to the compressed split path", async () => {
    const source = new TextEncoder().encode("compressible\n".repeat(2_000))
    await expect(prepareParts(`${"x".repeat(0x10000)}.txt`, "text/plain", source, 2_000)).rejects.toThrow(
      "file name or media type is too long",
    )
  })

  it("rejects a zstd payload whose declared original length was changed", async () => {
    const source = new TextEncoder().encode("bounded output\n".repeat(1_000))
    const packed = await packedFile("bounded.txt", "text/plain", source)
    const malformed = packed.container.slice()
    new DataView(malformed.buffer).setUint32(9, source.length + 1, true)

    await expect(unpackFile(malformed, packed.part)).rejects.toThrow("decompressed file length")
  })

  it("round trips a self-describing QR frame", () => {
    const block = raptorPacket(34, 1, 7)
    const header: FrameHeader = { totalLen: 8, containerTag: 0x1234n, part: STANDALONE_PART }
    const parsed = parseFrame(packFrame(header, block))

    expect(parsed?.header).toEqual({ ...header, packetLen: 12 })
    expect(parsed!.block).toEqual(block)
    expect(streamIdentity(parsed!.header)).toBe("standalone:0:0:0000000000001234:12:8")
  })

  it("writes a frame into caller-owned storage without copying an already adjacent block", () => {
    const header: FrameHeader = { totalLen: 8, containerTag: 0x1234n, part: STANDALONE_PART }
    const storage = new Uint8Array(STANDALONE_HEADER_LEN + 12)
    const block = storage.subarray(STANDALONE_HEADER_LEN)
    block.set(raptorPacket(34, 1, 3))

    expect(packFrameInto(header, block, storage)).toBe(storage)
    expect(storage).toEqual(packFrame(header, block))
  })

  it("rejects frame headers that could force an impossible container allocation", () => {
    const block = raptorPacket(0, 1)
    const oversized: FrameHeader = { totalLen: 0xffff_ffff, containerTag: 0n, part: STANDALONE_PART }
    const inconsistent: FrameHeader = { ...oversized, totalLen: 16 }

    expect(parseFrame(packFrame(oversized, block))).toBeNull()
    expect(parseFrame(packFrame(inconsistent, block))).toBeNull()
  })

  it("generates identical locked-version QR frames for live and exported sequences", () => {
    const container = Uint8Array.from({ length: 3072 }, (_, index) => (index * 73) & 0xff)
    const options = {
      container,
      containerTag: 0x0123456789abn,
      part: STANDALONE_PART,
      frameBytes: 500,
      ecc: "L" as const,
    }
    const live = new OpticalQrFrameEncoder(options)
    const exported = new OpticalQrFrameEncoder(options)

    for (const sequence of [0, 1, live.k, live.k + 7]) {
      const liveQr = live.encode(sequence)
      const exportedQr = exported.encode(sequence)
      expect(liveQr.size).toBe(exportedQr.size)
      expect(liveQr.packed).toEqual(exportedQr.packed)
    }

    expect(live.version).toBe(exported.version)
    expect(live.modules).toBe(exported.modules)
    expect(live.packetLen).toBe(symbolLength(500, 0) + 4)
    live.free()
    exported.free()
  })

  it("returns independent repair symbols and counts repeated ESIs as duplicates", () => {
    const payload = Uint8Array.from({ length: 45 }, (_, index) => index)
    const encoder = new RaptorQEncoder(payload, 8)
    const decoder = new RaptorQDecoder(encoder.packetLen, payload.length)
    const first = encoder.encode(0)
    const fresh = encoder.encode(0)
    expect(fresh).toEqual(first)
    decoder.addFrame(fresh)
    decoder.addFrame(fresh)
    expect(decoder.framesNew).toBe(1)
    expect(encoder.encode(1)).not.toEqual(first)
    decoder.free()
    encoder.free()
  })

  it("encodes into reusable packet storage without allocating a replacement", () => {
    const encoder = new RaptorQEncoder(
      Uint8Array.from({ length: 45 }, (_, index) => index),
      8,
    )
    const storage = new Uint8Array(encoder.packetLen)

    expect(encoder.encodeInto(3, storage)).toBe(storage)
    expect(storage).toEqual(encoder.encode(3))
    encoder.free()
  })

  it("recovers a RaptorQ stream from repair symbols with deterministic loss", () => {
    const payload = Uint8Array.from({ length: 4099 }, (_, index) => (index * 31) & 0xff)
    const encoder = new RaptorQEncoder(payload, 96)
    const decoder = new RaptorQDecoder(encoder.packetLen, payload.length)

    for (let sequence = 0; !decoder.isComplete && sequence < encoder.k * 3; sequence += 1) {
      if (sequence % 5 !== 0) decoder.addFrame(encoder.encode(sequence))
    }

    expect(decoder.assemble()).toEqual(payload)
    decoder.free()
    encoder.free()
  })

  it("grows decoder payload storage across more than 16 dependent repair symbols", () => {
    const payload = new Uint8Array(8)
    payload[0] = 1
    const encoder = new RaptorQEncoder(payload, 8)
    const decoder = new RaptorQDecoder(encoder.packetLen, payload.length)
    let dependent = 0
    let independent: Uint8Array | undefined

    for (let sequence = 0; sequence < 20_000 && (dependent < 20 || !independent); sequence++) {
      const packet = encoder.encode(sequence)
      const hasZeroPayload = packet.subarray(RAPTORQ_PAYLOAD_ID_BYTES).every((value) => value === 0)
      if (hasZeroPayload && dependent < 20) {
        decoder.addFrame(packet)
        expect(decoder.isComplete).toBe(false)
        dependent++
      } else if (!hasZeroPayload && dependent >= 20) {
        independent = packet
      }
    }

    expect(dependent).toBe(20)
    expect(independent).toBeDefined()
    decoder.addFrame(independent!)
    expect(decoder.assemble()).toEqual(payload)
    decoder.free()
    encoder.free()
  })

  it("aligns the RFC 6330 symbol while keeping the packet inside the requested frame", () => {
    expect(symbolLength(500, 0)).toBe(480)
    expect(STANDALONE_HEADER_LEN + symbolLength(500, 0) + 4).toBeLessThanOrEqual(500)
    expect(symbolLength(500, 1)).toBe(472)
    expect(frameHeaderLength(1) + symbolLength(500, 1) + 4).toBeLessThanOrEqual(500)
  })

  it("aligns the default 2953-byte frame after its variable header", () => {
    expect(symbolLength(2953, 0)).toBe(2928)
    expect(STANDALONE_HEADER_LEN + symbolLength(2953, 0) + 4).toBeLessThanOrEqual(2953)
    expect(symbolLength(2953, 1)).toBe(2920)
  })

  it("estimates progress only from distinct RaptorQ frames", () => {
    const collecting = estimateTransferProgress(100, 50, 5)
    const almostReady = estimateTransferProgress(100, 99, 9.9)
    const decoding = estimateTransferProgress(100, 100, 10)
    const overdue = estimateTransferProgress(100, 110, 11)

    expect(expectedRaptorQOverhead(100)).toBe(1.02)
    expect(collecting).toMatchObject({ expectedFrames: 102, phase: "collecting" })
    expect(collecting.fraction).toBeCloseTo(0.495)
    expect(almostReady.fraction).toBeCloseTo(0.9801)
    expect(decoding.phase).toBe("decoding")
    expect(decoding.fraction).toBe(0.99)
    expect(overdue.fraction).toBe(0.99)
  })
})

describe("segmented optical transfer", () => {
  it("caps the packed four-bit part fields at 16 pieces and 1 GiB", () => {
    expect(MAX_PART_COUNT).toBe(0x0f)
    expect(MAX_TRANSFER_BYTES).toBe(1024 * 1024 * 1024)
  })

  it("marks a standalone file outside the DCF5 container", async () => {
    const packed = await packedFile("standalone.txt", "text/plain", new TextEncoder().encode("hello"))

    expect([...packed.container.subarray(0, 4)]).toEqual([0x44, 0x43, 0x46, 0x35])
    expect(packed.part).toEqual({ index: 0, count: 0, transferId: undefined })
    expect((await unpackFile(packed.container, packed.part)).part).toEqual(STANDALONE_PART)
  })

  it("hashes large containers incrementally without changing their tag", async () => {
    const bytes = noise(STREAMING_FILE_READ_CHUNK_BYTES + 17, 0x64b17)
    await expect(getXXH3(bytes)).resolves.toBe(await xxh3(bytes))
  })

  it("keeps part metadata out of DCF5 and carries it through the frame header", async () => {
    const source = new TextEncoder().encode("part payload")
    const transferId = await getXXH3(source)
    const packed = await packedFile("piece.bin", "application/octet-stream", source, {
      index: 1,
      count: 2,
      transferId,
    })

    expect(new TextDecoder().decode(packed.container.subarray(17, 26))).toBe("piece.bin")
    expect(await getXXH3(packed.container)).toBe(packed.containerTag)
    const standalone = await packedFile("piece.bin", "application/octet-stream", source)
    expect(packed.container).toEqual(standalone.container)
    expect(packed.containerTag).toBe(standalone.containerTag)
    const frame = packFrame(
      { totalLen: packed.container.length, containerTag: packed.containerTag, part: packed.part },
      raptorPacket(0, Math.ceil(packed.container.length / 8)),
    )
    expect(frame[15]).toBe(0x21)
    expect(frame).toHaveLength(MULTIPART_HEADER_LEN + 12)
    expect(new DataView(frame.buffer).getBigUint64(16, false)).toBe(transferId)
    const parsed = parseFrame(frame)
    expect(parsed?.header.part).toEqual(packed.part)
    const recovered = await unpackFile(packed.container, parsed!.header.part)
    expect(recovered.name).toBe("piece.bin")
    expect(new TextDecoder().decode(recovered.bytes)).toBe("part payload")
    expect(recovered.part).toEqual({ index: 1, count: 2, transferId })
  })

  it("round trips a split file through per-part containers", async () => {
    const source = noise(257, 0xabcd)
    const parts = await prepareParts("seg.bin", "application/octet-stream", source, 100)

    expect(parts).toHaveLength(3)
    expect(parts.map((part) => part.part.index)).toEqual([0, 1, 2])
    expect(new Set(parts.map((part) => part.part.count))).toEqual(new Set([2]))
    const transferId = parts[0].part.transferId
    expect(parts.every((part) => part.part.transferId === transferId)).toBe(true)
    expect(transferId).toBe(await getXXH3(source))

    const recovered = await Promise.all(parts.map((part) => unpackFile(part.container, part.part)))
    expect(concatenateBytes(recovered.map((part) => part.bytes))).toEqual(source)
  })

  it("rejects frame part metadata whose index exceeds its count", async () => {
    const packed = await packedFile("piece.bin", "application/octet-stream", Uint8Array.of(1, 2, 3), {
      index: 0,
      count: 2,
      transferId: 0x123456789abcn,
    })
    await expect(unpackFile(packed.container, { ...packed.part, index: 3 })).rejects.toThrow("part index is invalid")
    expect(() =>
      packFrame(
        { totalLen: packed.container.length, containerTag: packed.containerTag, part: { ...packed.part, index: 3 } },
        raptorPacket(0, 1),
      ),
    ).toThrow("part placement is invalid")
  })

  it("filters incompatible or already received input from the first QR frame", () => {
    const expected = { transferId: 0x1234n, count: 2, missing: [1, 2] }

    expect(expectedTransferVerdict(STANDALONE_PART, expected)).toContain("standalone optical file")
    expect(expectedTransferVerdict({ index: 1, count: 2, transferId: 0x5678n }, expected)).toContain(
      "different transfer",
    )
    expect(expectedTransferVerdict({ index: 0, count: 2, transferId: 0x1234n }, expected)).toContain(
      "already been received",
    )
    expect(expectedTransferVerdict({ index: 1, count: 2, transferId: 0x1234n }, expected)).toBeNull()
  })

  it("rejects out-of-range part metadata and oversized part counts at pack time", async () => {
    await expect(
      packedFile("piece.bin", "application/octet-stream", Uint8Array.of(1), {
        index: 3,
        count: 2,
        transferId: 1n,
      }),
    ).rejects.toThrow("part index is invalid")
    await expect(
      packedFile("piece.bin", "application/octet-stream", Uint8Array.of(1), {
        index: 0,
        count: MAX_PART_COUNT + 1,
        transferId: 1n,
      }),
    ).rejects.toThrow("too many parts")
  })
})

describe("optical wire v2 RaptorQ conformance", () => {
  it("pins the frame header byte for byte", () => {
    const frame = goldenFrame()

    expect([...frame].map((byte) => byte.toString(16).padStart(2, "0")).join(" ")).toBe(
      "d1 c3 02 18 00 00 00 01 23 45 67 89 ab cd ef 00 00 00 00 03 01 02 03 04 05 06 07 08",
    )
    expect(frame).toHaveLength(STANDALONE_HEADER_LEN + 12)
    expect(parseFrame(frame)).toEqual({
      header: {
        packetLen: 12,
        totalLen: 24,
        containerTag: 0x0123456789abcdefn,
        part: STANDALONE_PART,
      },
      block: Uint8Array.of(0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8),
    })
  })

  it("distinguishes newer versions and unrelated QR codes", () => {
    expect(classifyFrame(withByte(2, 0))).toEqual({ kind: "malformed" })

    const newer = classifyFrame(withByte(2, WIRE_VERSION + 1))
    expect(newer).toEqual({ kind: "newer-sender", version: WIRE_VERSION + 1 })
    expect(frameVerdictMessage(newer)).toContain("Update this receiver")

    const foreign = withByte(0, 0xd2)
    expect(classifyFrame(foreign)).toEqual({ kind: "foreign" })
    expect(frameVerdictMessage(classifyFrame(foreign))).toBeNull()

    const retiredPrototypeMagic = withByte(1, 0x0d)
    expect(classifyFrame(retiredPrototypeMagic)).toEqual({ kind: "foreign" })
  })

  it("rejects an RFC 6330 source packet in the repair-only stream", () => {
    const frame = goldenFrame()
    frame[STANDALONE_HEADER_LEN + 3] = 2

    expect(classifyFrame(frame)).toEqual({ kind: "malformed" })
    expect(parseFrame(frame)).toBeNull()
  })
})

describe("optical transfer conformance", () => {
  it("recovers a real container through framed RFC 6330 repair symbols with deterministic loss", async () => {
    const source = noise(300_000, 0x5eed)
    const packed = await packedFile("payload.bin", "application/octet-stream", source)
    const encoder = new RaptorQEncoder(packed.container, symbolLength(FRAME_BYTES, packed.part.count))
    const packetLen = encoder.packetLen
    const containerTag = packed.containerTag
    const dropped = (sequence: number) => ((sequence * 2654435761) >>> 0) % 100 < 15

    expect(encoder.k).toBeGreaterThan(100)

    let decoder: RaptorQDecoder | null = null
    let receivedFrames = 0
    for (let sequence = 0; !decoder?.isComplete; sequence++) {
      expect(sequence).toBeLessThan(10_000)
      const frame = packFrame(
        {
          totalLen: packed.container.length,
          containerTag,
          part: packed.part,
        },
        encoder.encode(sequence),
      )
      expect(frame.length).toBeLessThanOrEqual(FRAME_BYTES)
      if (dropped(sequence)) continue

      const parsed = parseFrame(frame)
      expect(parsed).not.toBeNull()
      expect(parsed!.header.packetLen).toBe(packetLen)
      decoder ??= new RaptorQDecoder(parsed!.header.packetLen, parsed!.header.totalLen)
      decoder.addFrame(parsed!.block)
      receivedFrames++
    }

    const container = decoder.assemble()
    expect(container).not.toBeNull()
    expect(await getXXH3(container!)).toBe(containerTag)
    expect(receivedFrames / encoder.k).toBeLessThan(1.3)

    const recovered = await unpackFile(container!, packed.part)
    expect(recovered.name).toBe("payload.bin")
    expect(recovered.bytes).toEqual(source)
    decoder.free()
    encoder.free()
  })
})

describe("NanoRQ WASM module", () => {
  function expectQrMatchesReference(codec: NanoRQCodecModule): void {
    const qr = codec._nanorq_qr_new()
    expect(qr).not.toBe(0)
    try {
      const input = codec._nanorq_qr_input(qr)
      const cases = [
        { length: 10, ecc: "L" as const, eccCode: 0, version: 1 },
        { length: 512, ecc: "Q" as const, eccCode: 2, version: 39 },
        { length: 512, ecc: "Q" as const, eccCode: 2, version: 40 },
        { length: 2_953, ecc: "L" as const, eccCode: 0, version: 40 },
      ]
      for (const testCase of cases) {
        // The second seed exercises the cached layout with different codewords.
        for (const seed of [41, 167]) {
          const payload = Uint8Array.from({ length: testCase.length }, (_, index) => (index * 73 + seed) & 0xff)
          const expected = referenceTransferQr(payload, testCase.ecc, testCase.version)
          codec.HEAPU8.set(payload, input)
          const size = codec._nanorq_qr_encode(
            qr,
            payload.length,
            testCase.eccCode,
            testCase.version,
            testCase.version,
            3,
          )
          expect(size).toBe(expected.size)
          const packedPointer = codec._nanorq_qr_packed(qr)
          const packed = codec.HEAPU8.subarray(packedPointer, packedPointer + Math.ceil((size * size) / 8))
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const index = y * size + x
              expect(Boolean(packed[index >> 3] & (1 << (index & 7)))).toBe(expected.get(x, y))
            }
          }
        }
      }
    } finally {
      codec._nanorq_qr_free(qr)
    }
  }

  it("instantiates from a precompiled WebAssembly Module without fetching", async () => {
    const bytes = readFileSync("frontend/optical/nanorq-codec/nanorq_codec_simd.wasm")
    const wasmModule = await WebAssembly.compile(bytes)
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    const codec = await createNanoRQCodec({
      instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(wasmModule, imports)
        done(instance, wasmModule)
        return instance.exports
      },
    })

    expect(codec._nanorq_simd_enabled()).toStrictEqual(1)
    expectQrMatchesReference(codec)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("runs the scalar fallback through the same JavaScript glue", async () => {
    const wasm = readFileSync("frontend/optical/nanorq-codec/nanorq_codec_scalar.wasm")
    const codec = await createNanoRQCodec({ wasmBinary: wasm })

    expect(codec._nanorq_simd_enabled()).toStrictEqual(0)
    expect(codec._nanorq_simd_self_test()).toStrictEqual(1)
    expectQrMatchesReference(codec)
  })
})
