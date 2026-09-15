import { readFileSync } from "node:fs"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { initializeZstdDecoder, initializeZstdEncoder } from "../wasm/zstd-runtime.js"
import { initializeXXHash } from "../wasm/xxhash-runtime.js"
import { STREAMING_FILE_READ_CHUNK_BYTES } from "../../shared/constants.js"
import { prepareOpticalTransfer } from "../optical/send/prepared-transfer.js"
import { unpackFile } from "../optical/shared/protocol.js"

beforeAll(async () => {
  await Promise.all([
    initializeZstdEncoder(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm")),
    initializeZstdDecoder(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm")),
    initializeXXHash(readFileSync("frontend/wasm/xxhash/xxhash_simd.wasm")),
  ])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function noise(length: number): Uint8Array<ArrayBuffer> {
  let state = 0x1234abcd
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

describe("lazy optical transfer preparation", () => {
  it("reports a file deleted while optical compression is reading it", async () => {
    const file = new File(["compressible text\n".repeat(100)], "deleted-during-qr-compression.txt", {
      type: "text/plain",
    })
    vi.spyOn(file, "slice").mockImplementation(
      () =>
        ({
          arrayBuffer: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
        }) as Blob,
    )

    await expect(prepareOpticalTransfer(file)).rejects.toMatchObject({
      name: "FileReadError",
      message:
        'Could not read "deleted-during-qr-compression.txt". It may have been moved, deleted, or changed since it was selected. ' +
        "Select the file again and retry.",
    })
  })

  it("reports a file deleted while a raw optical part is being built", async () => {
    const bytes = noise(257)
    const file = new File([bytes], "deleted-during-qr-split.zip", { type: "application/zip" })
    const originalSlice = file.slice.bind(file)
    let unreadable = false
    vi.spyOn(file, "slice").mockImplementation((start, end, contentType) => {
      if (!unreadable) return originalSlice(start, end, contentType)
      return {
        arrayBuffer: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
      } as Blob
    })
    const transfer = await prepareOpticalTransfer(file, { partPayloadSize: 100 })

    unreadable = true
    await expect(transfer.getPart(1)).rejects.toMatchObject({
      name: "FileReadError",
      message:
        'Could not read "deleted-during-qr-split.zip". It may have been moved, deleted, or changed since it was selected. ' +
        "Select the file again and retry.",
    })
    await transfer.cleanup()
  })

  it("prepares transferred memory without reading a Blob", async () => {
    const bytes = noise(257)
    const transfer = await prepareOpticalTransfer(
      { name: "standalone.zip", type: "application/zip", data: bytes.buffer },
      { partPayloadSize: 100 },
    )

    expect(transfer.summary).toMatchObject({ compression: "none", transmittedSize: 257, partCount: 3 })
    const packed = await transfer.getPart(2)
    const recovered = await unpackFile(packed.container, packed.part)
    expect(recovered.bytes).toEqual(bytes.subarray(200))
    await transfer.cleanup()
  })

  it("serializes a media-type override without wrapping the source File", async () => {
    const file = new File(["const answer = 42"], "paste.txt", { type: "text/plain" })
    const transfer = await prepareOpticalTransfer(file, {
      mediaType: "text/plain; x-pb-highlight=javascript",
    })

    const packed = await transfer.getPart(0)
    const recovered = await unpackFile(packed.container, packed.part)
    expect(recovered.type).toBe("text/plain; x-pb-highlight=javascript")
    expect(new TextDecoder().decode(recovered.bytes)).toBe("const answer = 42")
    await transfer.cleanup()
  })

  it("keeps compressed transferred memory out of blob-backed Files", async () => {
    const bytes = new TextEncoder().encode("standalone compressible payload\n".repeat(1_000))
    class RejectingFile extends File {
      constructor() {
        super([], "unexpected")
        throw new Error("A standalone compressed payload must not create a File")
      }
    }
    vi.stubGlobal("File", RejectingFile)

    const transfer = await prepareOpticalTransfer({ name: "standalone.txt", type: "text/plain", data: bytes.buffer })
    expect(transfer.summary.compression).toBe("zstd")
    await expect(transfer.getPart(0)).resolves.toMatchObject({ compression: "zstd" })
    await transfer.cleanup()
  })

  it("reads and packs only the requested raw part", async () => {
    const bytes = noise(257)
    const file = new File([bytes], "already.zip", { type: "application/zip" })
    const transfer = await prepareOpticalTransfer(file, { partPayloadSize: 100 })

    expect(transfer.summary).toMatchObject({ compression: "none", transmittedSize: 257, partCount: 3 })
    const packed = await transfer.getPart(1)
    const recovered = await unpackFile(packed.container, packed.part)
    expect(recovered.part).toMatchObject({ index: 1, count: 2 })
    expect(recovered.bytes).toEqual(bytes.subarray(100, 200))

    await transfer.cleanup()
    await expect(transfer.getPart(0)).rejects.toThrow("no longer prepared")
  })

  it("copies a large raw part into its container in bounded chunks", async () => {
    const bytes = noise(STREAMING_FILE_READ_CHUNK_BYTES + 257)
    const file = new File([bytes], "already.zip", { type: "application/zip" })
    const slice = vi.spyOn(file, "slice")
    const transfer = await prepareOpticalTransfer(file)

    const packed = await transfer.getPart(0)

    expect(slice).toHaveBeenCalledTimes(2)
    expect(slice.mock.calls.map(([start, end]) => [start, end])).toEqual([
      [0, STREAMING_FILE_READ_CHUNK_BYTES],
      [STREAMING_FILE_READ_CHUNK_BYTES, bytes.length],
    ])
    expect(packed.transmittedSize).toBe(bytes.length)
    expect(packed.container.length).toBeGreaterThan(bytes.length)
    await transfer.cleanup()
  })

  it("stops reading a part after its prefetch is cancelled", async () => {
    const bytes = noise(STREAMING_FILE_READ_CHUNK_BYTES + 257)
    const file = new File([bytes], "already.zip", { type: "application/zip" })
    const originalSlice = file.slice.bind(file)
    const controller = new AbortController()
    const slice = vi.spyOn(file, "slice").mockImplementation((start, end, contentType) => {
      const chunk = originalSlice(start, end, contentType)
      return {
        arrayBuffer: async () => {
          const buffer = await chunk.arrayBuffer()
          controller.abort()
          return buffer
        },
      } as Blob
    })
    const transfer = await prepareOpticalTransfer(file)

    await expect(transfer.getPart(0, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(slice).toHaveBeenCalledOnce()
    await transfer.cleanup()
  })

  it("streams one zstd frame and materializes its fragments on demand", async () => {
    const lines = Array.from(
      { length: 3_000 },
      (_, index) => `2026-08-23 INFO request-${String(index).padStart(6, "0")} completed in ${(index * 17) % 101}ms\n`,
    )
    const bytes = new TextEncoder().encode(lines.join(""))
    const transfer = await prepareOpticalTransfer(new File([bytes], "events.log", { type: "text/plain" }), {
      partPayloadSize: 1_000,
    })

    expect(transfer.summary.compression).toBe("zstd")
    expect(transfer.summary.partCount).toBeGreaterThan(1)
    const packed = await Promise.all(
      Array.from({ length: transfer.summary.partCount }, (_, index) => transfer.getPart(index)),
    )
    const recovered = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    expect(recovered.map((part) => part.part.index)).toEqual(
      Array.from({ length: transfer.summary.partCount }, (_, index) => index),
    )
    expect(recovered.reduce((total, part) => total + part.bytes.byteLength, 0)).toBe(transfer.summary.transmittedSize)
    await transfer.cleanup()
  })

  it("reuses the compression input pass for a multipart transfer id", async () => {
    const bytes = noise(64 * 1024)
    const file = new File([bytes], "incompressible.txt", { type: "text/plain" })
    const slice = vi.spyOn(file, "slice")
    const transfer = await prepareOpticalTransfer(file, { partPayloadSize: 32 * 1024 })

    expect(transfer.summary).toMatchObject({ compression: "none", partCount: 2 })
    expect(slice).toHaveBeenCalledOnce()
    expect(slice).toHaveBeenCalledWith(0, bytes.length)
    await transfer.cleanup()
  })

  it("stores a large compression candidate in OPFS and removes it on cleanup", async () => {
    const written: BlobPart[] = []
    const removeEntry = vi.fn(() => Promise.resolve())
    const getDirectory = vi.fn(() =>
      Promise.resolve({
        getFileHandle: vi.fn((name: string) =>
          Promise.resolve({
            createWritable: vi.fn(() =>
              Promise.resolve({
                write: vi.fn((chunk: BlobPart) => {
                  written.push(chunk)
                  return Promise.resolve()
                }),
                close: vi.fn(() => Promise.resolve()),
                abort: vi.fn(() => Promise.resolve()),
              }),
            ),
            getFile: vi.fn(() => Promise.resolve(new File(written, name, { type: "application/zstd" }))),
          }),
        ),
        removeEntry,
      }),
    )
    vi.stubGlobal("navigator", {
      storage: {
        estimate: vi.fn(() => Promise.resolve({ quota: 1_000_000_000, usage: 0 })),
        getDirectory,
      },
    })

    const bytes = new TextEncoder().encode("disk-backed optical payload\n".repeat(10_000))
    const transfer = await prepareOpticalTransfer(new File([bytes], "large.txt", { type: "text/plain" }), {
      opfsThreshold: 1,
    })

    expect(getDirectory).toHaveBeenCalledOnce()
    expect(written.length).toBeGreaterThan(0)
    await transfer.cleanup()
    expect(removeEntry).toHaveBeenCalledOnce()
  })
})
