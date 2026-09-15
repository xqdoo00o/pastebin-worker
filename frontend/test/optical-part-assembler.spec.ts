import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { initializeZstdDecoder, initializeZstdEncoder } from "../wasm/zstd-runtime.js"
import { initializeXXHash } from "../wasm/xxhash-runtime.js"
import { MultipartOpticalAssembler, OpticalPartTransferMismatchError } from "../optical/receive/part-assembler.js"
import { prepareOpticalTransfer } from "../optical/send/prepared-transfer.js"
import { unpackFile, type PackedOpticalFile } from "../optical/shared/protocol.js"
import type { OPFSTemporaryFile } from "../utils/opfs.js"

beforeAll(async () => {
  await Promise.all([
    initializeZstdEncoder(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm")),
    initializeZstdDecoder(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm")),
    initializeXXHash(readFileSync("frontend/wasm/xxhash/xxhash_simd.wasm")),
  ])
})

function memoryTemporaryFile() {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const cleanup = vi.fn(() => Promise.resolve())
  const deferCleanup = vi.fn()
  const abort = vi.fn(() => Promise.resolve())
  const write = vi.fn((data: FileSystemWriteChunkType) => {
    const bytes = data as Uint8Array
    chunks.push(Uint8Array.from(bytes))
    return Promise.resolve()
  })
  const temporary: OPFSTemporaryFile = {
    write,
    finish: vi.fn((name: string, type: string) =>
      Promise.resolve({
        file: new File(chunks, name, { type }),
        cleanup,
        deferCleanup,
      }),
    ),
    abort,
  }
  return { temporary, cleanup, deferCleanup, abort, write }
}

function noise(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 97 + 31) & 0xff)
}

async function prepareParts(
  name: string,
  type: string,
  bytes: Uint8Array,
  partPayloadSize: number,
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

describe("disk-backed optical part assembly", () => {
  it("writes raw parts in order, releases their buffers, and verifies the stored file", async () => {
    const source = noise(257)
    const packed = await prepareParts("raw.bin", "application/octet-stream", source, 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryFile()
    const assembler = new MultipartOpticalAssembler(() => Promise.resolve(memory.temporary))

    expect(await assembler.accept(parts[0])).toBeUndefined()
    expect(memory.write).toHaveBeenCalledOnce()
    expect(await assembler.accept(parts[2])).toBeUndefined()
    expect(assembler.progress()).toEqual({ received: 2, total: 3, missing: [2] })
    const result = await assembler.accept(parts[1])

    expect(new Uint8Array(await result!.file.arrayBuffer())).toEqual(source)
    expect(result!.wasCompressed).toBe(false)
    expect(assembler.progress()).toBeUndefined()
    expect(memory.abort).not.toHaveBeenCalled()
  })

  it("streams one fragmented zstd frame into the OPFS output", async () => {
    const lines: string[] = []
    for (let index = 0; index < 3_000; index++) {
      lines.push(
        `2026-08-22 10:00:${String(index % 60).padStart(2, "0")} INFO task-${String(index).padStart(6, "0")} complete in ${String(((index * 7) % 40) + 1)}ms\n`,
      )
    }
    const source = new TextEncoder().encode(lines.join(""))
    const packed = await prepareParts("logs.txt", "text/plain", source, 1_000)
    expect(packed.every((part) => part.compression === "zstd-fragment")).toBe(true)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryFile()
    const assembler = new MultipartOpticalAssembler(() => Promise.resolve(memory.temporary))
    let result

    // Out-of-order fragments wait without corrupting the one zstd frame.
    for (const part of [...parts].reverse()) result = (await assembler.accept(part)) ?? result

    if (!result) throw new Error("The final optical part did not complete the transfer.")
    expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(Uint8Array.from(source))
    expect(result.wasCompressed).toBe(true)
    expect(assembler.progress()).toBeUndefined()
  })

  it("rejects a part from another transfer without discarding current progress", async () => {
    const source = noise(257)
    const otherSource = Uint8Array.from(source, (byte, index) => byte ^ ((index % 7) + 1))
    const packed = await prepareParts("raw.bin", "application/octet-stream", source, 100)
    const otherPacked = await prepareParts("raw.bin", "application/octet-stream", otherSource, 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const otherParts = await Promise.all(otherPacked.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryFile()
    const assembler = new MultipartOpticalAssembler(() => Promise.resolve(memory.temporary))

    await assembler.accept(parts[0])
    await expect(assembler.accept(otherParts[1])).rejects.toBeInstanceOf(OpticalPartTransferMismatchError)
    expect(assembler.progress()).toEqual({ received: 1, total: 3, missing: [2, 3] })
    expect(memory.abort).not.toHaveBeenCalled()

    await assembler.accept(parts[1])
    const result = await assembler.accept(parts[2])
    expect(new Uint8Array(await result!.file.arrayBuffer())).toEqual(source)
  })

  it("rejects a standalone file while a multipart transfer is in progress", async () => {
    const source = noise(257)
    const packed = await prepareParts("raw.bin", "application/octet-stream", source, 100)
    const standalonePacked = await prepareParts("other.bin", "application/octet-stream", noise(80), 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const standalone = await unpackFile(standalonePacked[0].container, standalonePacked[0].part)
    const memory = memoryTemporaryFile()
    const assembler = new MultipartOpticalAssembler(() => Promise.resolve(memory.temporary))

    await assembler.accept(parts[0])
    expect(() => assembler.assertCompatibleTransfer(standalone)).toThrow(
      "standalone optical file does not belong to the multipart transfer",
    )
    expect(assembler.progress()).toEqual({ received: 1, total: 3, missing: [2, 3] })
    expect(memory.abort).not.toHaveBeenCalled()
  })

  it("clears multipart progress immediately while temporary-file cleanup finishes", async () => {
    const source = noise(257)
    const packed = await prepareParts("raw.bin", "application/octet-stream", source, 100)
    const firstPart = await unpackFile(packed[0].container, packed[0].part)
    const memory = memoryTemporaryFile()
    let finishAbort!: () => void
    memory.abort.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAbort = resolve
        }),
    )
    const assembler = new MultipartOpticalAssembler(() => Promise.resolve(memory.temporary))

    await assembler.accept(firstPart)
    expect(assembler.progress()).toEqual({ received: 1, total: 3, missing: [2, 3] })

    const reset = assembler.reset()
    expect(memory.abort).toHaveBeenCalledOnce()
    expect(assembler.progress()).toBeUndefined()
    expect(assembler.expectedTransfer()).toBeUndefined()

    finishAbort()
    await reset
  })

  it("aborts the temporary file when Web Crypto verification fails", async () => {
    const source = noise(257)
    const packed = await prepareParts("bad.bin", "application/octet-stream", source, 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    parts[1].bytes[0] ^= 1
    const memory = memoryTemporaryFile()
    const assembler = new MultipartOpticalAssembler(() => Promise.resolve(memory.temporary))

    await assembler.accept(parts[0])
    await assembler.accept(parts[1])
    await expect(assembler.accept(parts[2])).rejects.toThrow("transfer id")
    expect(memory.cleanup).toHaveBeenCalledOnce()
    expect(memory.abort).not.toHaveBeenCalled()
  })
})
