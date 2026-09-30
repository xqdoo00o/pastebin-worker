import { initializeTransferTestCodecs } from "./transfer-codec-test.js"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { MultipartOpticalAssembler, OpticalPartTransferMismatchError } from "../optical/receive/part-assembler.js"
import { prepareOpticalParts as prepareParts } from "./optical-transfer-helper.js"
import { unpackFile } from "../optical/shared/protocol.js"
import type { CompletedOPFSTemporaryFile, OPFSTemporaryFile } from "../utils/opfs.js"
import { STREAMING_FILE_READ_CHUNK_BYTES } from "../../shared/constants.js"

beforeAll(initializeTransferTestCodecs)

function memoryTemporaryFile() {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const completed: CompletedOPFSTemporaryFile[] = []
  const cleanup = vi.fn(() => Promise.resolve())
  const deferCleanup = vi.fn()
  const abort = vi.fn(() => Promise.resolve())
  const write = vi.fn((data: FileSystemWriteChunkType) => {
    const bytes = data as Uint8Array
    chunks.push(Uint8Array.from(bytes))
    return Promise.resolve()
  })
  const finish = vi.fn((name: string, type: string) => {
    const result = {
      file: new File(chunks, name, { type }),
      cleanup,
      deferCleanup,
    }
    completed.push(result)
    return Promise.resolve(result)
  })
  const temporary: OPFSTemporaryFile = { write, finish, abort }
  return { temporary, cleanup, deferCleanup, abort, write, finish, completed }
}

function memoryTemporaryStore() {
  const first = memoryTemporaryFile()
  const files: ReturnType<typeof memoryTemporaryFile>[] = []
  const create = vi.fn((_expectedSize: number, _purpose: "optical") => {
    const entry = files.length === 0 ? first : memoryTemporaryFile()
    files.push(entry)
    return Promise.resolve(entry.temporary)
  })
  return { ...first, files, create }
}

function noise(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 97 + 31) & 0xff)
}

describe("disk-backed optical part assembly", () => {
  it("persists out-of-order parts immediately and reads them back in bounded chunks", async () => {
    const partSize = STREAMING_FILE_READ_CHUNK_BYTES + 7
    const source = noise(partSize * 2 + 11)
    const packed = await prepareParts("raw.zip", "application/zip", source, partSize)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)

    await assembler.accept(parts[1])
    expect(memory.create).toHaveBeenCalledWith(partSize, "optical")
    expect(memory.finish).toHaveBeenCalledOnce()
    const stored = memory.completed[0]
    const slice = vi.spyOn(stored.file, "slice")
    // Discarding the caller's data cannot affect the already persisted part.
    parts[1].bytes.fill(0)
    await assembler.accept(parts[1])
    expect(memory.create).toHaveBeenCalledOnce()
    await assembler.accept(parts[2])
    expect(memory.files).toHaveLength(2)

    const result = await assembler.accept(parts[0])
    expect(slice.mock.calls.map(([start, end]) => [start, end])).toEqual([
      [0, STREAMING_FILE_READ_CHUNK_BYTES],
      [STREAMING_FILE_READ_CHUNK_BYTES, partSize],
    ])
    expect(memory.files[0].cleanup).toHaveBeenCalledOnce()
    expect(memory.files[1].cleanup).toHaveBeenCalledOnce()
    expect(memory.files[2].cleanup).not.toHaveBeenCalled()
    const recovered = new Uint8Array(await result!.file.arrayBuffer())
    expect(recovered.length).toBe(source.length)
    expect(recovered.every((byte, index) => byte === source[index])).toBe(true)
  })

  it("removes staged parts when reset before part zero arrives", async () => {
    const packed = await prepareParts("raw.zip", "application/zip", noise(257), 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)
    await assembler.accept(parts[2])
    await assembler.accept(parts[1])

    const reset = assembler.reset()
    expect(assembler.progress()).toBeUndefined()
    await reset
    expect(memory.files).toHaveLength(2)
    for (const file of memory.files) expect(file.cleanup).toHaveBeenCalledOnce()
  })

  it("cleans every staged file and the output when reading a stored part fails", async () => {
    const packed = await prepareParts("raw.zip", "application/zip", noise(257), 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)
    await assembler.accept(parts[1])
    await assembler.accept(parts[2])
    const stored = memory.completed[0]
    vi.spyOn(stored.file, "slice").mockImplementation(() => {
      throw new Error("OPFS read failed")
    })

    await expect(assembler.accept(parts[0])).rejects.toThrow("OPFS read failed")
    expect(memory.files[0].cleanup).toHaveBeenCalledOnce()
    expect(memory.files[1].cleanup).toHaveBeenCalledOnce()
    expect(memory.files[2].abort).toHaveBeenCalledOnce()
    expect(assembler.progress()).toBeUndefined()
  })

  it("aborts failed staging writes and removes previously stored parts", async () => {
    const packed = await prepareParts("raw.zip", "application/zip", noise(257), 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)
    await assembler.accept(parts[2])
    const failed = memoryTemporaryFile()
    failed.write.mockRejectedValueOnce(new Error("OPFS full"))
    memory.create.mockResolvedValueOnce(failed.temporary)

    await expect(assembler.accept(parts[1])).rejects.toThrow("OPFS full")
    expect(failed.abort).toHaveBeenCalledOnce()
    expect(memory.cleanup).toHaveBeenCalledOnce()
    expect(assembler.progress()).toBeUndefined()
  })

  it("cleans a staging file that finishes after reset without affecting a new transfer", async () => {
    const packed = await prepareParts("raw.zip", "application/zip", noise(257), 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    memory.finish.mockImplementation(async (name, type) => {
      await gate
      return {
        file: new File([parts[2].bytes.slice()], name, { type }),
        cleanup: memory.cleanup,
        deferCleanup: memory.deferCleanup,
      }
    })
    const assembler = new MultipartOpticalAssembler(memory.create)
    const accepting = expect(assembler.accept(parts[2])).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(memory.finish).toHaveBeenCalledOnce())
    const reset = assembler.reset()
    const next = assembler.accept(parts[0])
    expect(assembler.progress()).toBeUndefined()
    release()
    await accepting
    await reset
    await next
    expect(memory.cleanup).toHaveBeenCalledOnce()
    expect(assembler.progress()).toEqual({ received: 1, total: 3, missing: [2, 3] })
    await assembler.reset()
  })

  it("writes raw parts in order, releases their buffers, and verifies the stored file", async () => {
    const source = noise(257)
    const packed = await prepareParts("raw.bin", "application/octet-stream", source, 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)

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
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)
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
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)

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
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)

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
    const memory = memoryTemporaryStore()
    let finishAbort!: () => void
    memory.abort.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAbort = resolve
        }),
    )
    const assembler = new MultipartOpticalAssembler(memory.create)

    await assembler.accept(firstPart)
    expect(assembler.progress()).toEqual({ received: 1, total: 3, missing: [2, 3] })

    const reset = assembler.reset()
    await vi.waitFor(() => expect(memory.abort).toHaveBeenCalledOnce())
    expect(assembler.progress()).toBeUndefined()
    expect(assembler.expectedTransfer()).toBeUndefined()

    finishAbort()
    await reset
  })

  it("aborts the temporary file when XXH3 verification fails", async () => {
    const source = noise(257)
    const packed = await prepareParts("bad.bin", "application/octet-stream", source, 100)
    const parts = await Promise.all(packed.map((part) => unpackFile(part.container, part.part)))
    parts[1].bytes[0] ^= 1
    const memory = memoryTemporaryStore()
    const assembler = new MultipartOpticalAssembler(memory.create)

    await assembler.accept(parts[0])
    await assembler.accept(parts[1])
    await expect(assembler.accept(parts[2])).rejects.toThrow("transfer id")
    expect(memory.cleanup).toHaveBeenCalledOnce()
    expect(memory.abort).not.toHaveBeenCalled()
  })
})
