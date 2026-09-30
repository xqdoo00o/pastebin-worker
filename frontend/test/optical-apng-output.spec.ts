import { describe, expect, it, vi } from "vitest"
import { StreamedFileCollector } from "../utils/streamedOutput.js"
import type { CompletedOPFSTemporaryFile, OPFSTemporaryFile } from "../utils/opfs.js"

describe("APNG output storage", () => {
  it("finishes below the threshold without opening OPFS", async () => {
    const create = vi.fn<() => Promise<OPFSTemporaryFile>>()
    const output = new StreamedFileCollector({ createTemporaryFile: create, thresholdBytes: 4, purpose: "optical" })

    await output.append([Uint8Array.of(1, 2), Uint8Array.of(3, 4)])
    const result = await output.finish("small.png", "image/png")

    expect(create).not.toHaveBeenCalled()
    expect(result.cleanup).toBeUndefined()
    expect(result.file.name).toBe("small.png")
    expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4))
  })

  it("spills buffered batches once actual PNG bytes cross the threshold", async () => {
    const written: Uint8Array<ArrayBuffer>[] = []
    const cleanup = vi.fn(() => Promise.resolve())
    const deferCleanup = vi.fn()
    const write = vi.fn(async (data: FileSystemWriteChunkType) => {
      expect(data).toBeInstanceOf(Blob)
      written.push(new Uint8Array(await (data as Blob).arrayBuffer()))
    })
    const finish = vi.fn((name: string, type: string) =>
      Promise.resolve({ file: new File(written, name, { type }), cleanup, deferCleanup }),
    )
    const abort = vi.fn(() => Promise.resolve())
    const temporary: OPFSTemporaryFile = {
      write,
      finish,
      abort,
    }
    const create = vi.fn(() => Promise.resolve(temporary))
    const output = new StreamedFileCollector({ createTemporaryFile: create, thresholdBytes: 4, purpose: "optical" })

    await output.append([Uint8Array.of(1), Uint8Array.of(2, 3)])
    expect(create).not.toHaveBeenCalled()
    await output.append([Uint8Array.of(4), Uint8Array.of(5)])
    expect(create).toHaveBeenCalledWith(5, "optical")
    await output.append([Uint8Array.of(6)])
    const result = await output.finish("transfer.png", "image/png")
    expect(result.file.name).toBe("transfer.png")
    expect(result.file.type).toBe("image/png")
    expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6))
    expect(write).toHaveBeenCalledTimes(3)
    result.deferCleanup?.()
    expect(deferCleanup).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
  })

  it("aborts the OPFS file after a cancelled export", async () => {
    const abort = vi.fn(() => Promise.resolve())
    const temporary: OPFSTemporaryFile = {
      write: () => Promise.resolve(),
      finish: (name, type) =>
        Promise.resolve({ file: new File([], name, { type }), cleanup: abort, deferCleanup: vi.fn() }),
      abort,
    }
    const output = new StreamedFileCollector({
      createTemporaryFile: () => Promise.resolve(temporary),
      thresholdBytes: 1,
    })
    await output.append([Uint8Array.of(1, 2)])
    await output.abort()
    expect(abort).toHaveBeenCalledOnce()
    await expect(output.append([Uint8Array.of(3)])).rejects.toThrow("closed")
  })

  it.each([new Error("OPFS is unavailable"), new DOMException("Not enough browser storage", "QuotaExceededError")])(
    "keeps every batch in memory when creating OPFS fails: %s",
    async (error) => {
      const create = vi.fn<() => Promise<OPFSTemporaryFile>>().mockRejectedValue(error)
      const output = new StreamedFileCollector({ createTemporaryFile: create, thresholdBytes: 2, purpose: "optical" })
      await output.append([Uint8Array.of(1, 2)])
      await output.append([Uint8Array.of(3)])
      await output.append([Uint8Array.of(4, 5)])

      const result = await output.finish("fallback.png", "image/png")
      expect(create).toHaveBeenCalledOnce()
      expect(result.cleanup).toBeUndefined()
      expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    },
  )

  it("reclaims OPFS acquired after cancellation instead of falling back to memory", async () => {
    let acquired!: (temporary: OPFSTemporaryFile) => void
    const create = vi.fn(() => new Promise<OPFSTemporaryFile>((resolve) => (acquired = resolve)))
    const output = new StreamedFileCollector({ createTemporaryFile: create, thresholdBytes: 1 })
    const writing = output.append([Uint8Array.of(1, 2)])
    const rejected = expect(writing).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    const cancelling = output.abort()
    const temporary = { write: vi.fn(), finish: vi.fn(), abort: vi.fn(() => Promise.resolve()) }
    acquired(temporary)

    await rejected
    await cancelling
    expect(temporary.write).not.toHaveBeenCalled()
    expect(temporary.abort).toHaveBeenCalledOnce()
    await expect(output.finish("cancelled.png", "image/png")).rejects.toThrow("closed")
  })

  it("cleans a completed file when cancellation occurs during closing", async () => {
    let closed!: (completed: CompletedOPFSTemporaryFile) => void
    const finish = vi.fn(() => new Promise<CompletedOPFSTemporaryFile>((resolve) => (closed = resolve)))
    const abort = vi.fn(() => Promise.resolve())
    const temporary: OPFSTemporaryFile = {
      write: () => Promise.resolve(),
      finish,
      abort,
    }
    const output = new StreamedFileCollector({
      createTemporaryFile: () => Promise.resolve(temporary),
      thresholdBytes: 1,
    })
    await output.append([Uint8Array.of(1, 2)])
    const finishing = output.finish("cancelled.png", "image/png")
    const rejected = expect(finishing).rejects.toMatchObject({ name: "AbortError" })
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
    const cancelling = output.abort()
    const cleanup = vi.fn(() => Promise.resolve())
    closed({ file: new File([], "cancelled.png"), cleanup, deferCleanup: vi.fn() })

    await rejected
    await cancelling
    await output.abort()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
  })
})
