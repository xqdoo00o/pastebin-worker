import { describe, expect, it, vi } from "vitest"
import {
  arrayBufferByteSource,
  blobByteSource,
  readFileBytes,
  readByteSourceChunks,
  readByteSourceRangeChunks,
  type RandomAccessByteSource,
} from "../utils/byteSource.js"

async function collect(source: RandomAccessByteSource, chunkSize: number, signal?: AbortSignal): Promise<number[][]> {
  const chunks: number[][] = []
  for await (const chunk of readByteSourceChunks(source, chunkSize, signal)) chunks.push([...chunk])
  return chunks
}

describe("random-access byte sources", () => {
  it("uses File.arrayBuffer rather than a full-range slice for complete reads", async () => {
    const file = new File([Uint8Array.of(1, 2, 3)], "safari.bin")
    const arrayBuffer = vi.spyOn(file, "arrayBuffer")
    const slice = vi.spyOn(file, "slice")

    expect([...(await readFileBytes(file))]).toEqual([1, 2, 3])
    expect(arrayBuffer).toHaveBeenCalledOnce()
    expect(slice).not.toHaveBeenCalled()
  })

  it("reads Blob and ArrayBuffer slices through the same interface", async () => {
    const bytes = Uint8Array.of(0, 1, 2, 3, 4, 5, 6)
    const sources = [blobByteSource(new Blob([bytes])), arrayBufferByteSource(bytes.buffer)]

    for (const source of sources) {
      expect(source.size).toBe(bytes.byteLength)
      expect([...(await source.read(2, 5))]).toEqual([2, 3, 4])
      expect(await collect(source, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]])
    }
  })

  it("rejects a source that ends before its declared size", async () => {
    const source: RandomAccessByteSource = {
      size: 4,
      read: () => Uint8Array.of(1),
    }

    await expect(collect(source, 4)).rejects.toThrow("unexpected number of bytes")
  })

  it("reads a bounded range through the same chunk validation", async () => {
    const source = arrayBufferByteSource(Uint8Array.of(0, 1, 2, 3, 4, 5, 6).buffer)
    const chunks: number[][] = []
    for await (const chunk of readByteSourceRangeChunks(source, 2, 6, 3)) chunks.push([...chunk])

    expect(chunks).toEqual([[2, 3, 4], [5]])
    const invalidRange = (async () => {
      for await (const _chunk of readByteSourceRangeChunks(source, 2, 8, 3)) {
        // Consume the generator so its range validation runs.
      }
    })()
    await expect(invalidRange).rejects.toThrow("range is invalid")
  })

  it("checks cancellation again after an asynchronous read", async () => {
    const controller = new AbortController()
    const source: RandomAccessByteSource = {
      size: 4,
      read() {
        controller.abort()
        return Promise.resolve(Uint8Array.of(1, 2, 3, 4))
      },
    }

    await expect(collect(source, 4, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })
})
