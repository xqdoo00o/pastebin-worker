import { describe, expect, it, vi } from "vitest"

import { ApngDecodeSource } from "../optical/receive/apng-source.js"
import type { ApngParserWorkerOutput } from "../optical/shared/worker-messages.js"

const metadata = { scale: 4, grid: 2, qr: 40 } as const

class ParserWorkerStub {
  static latest: ParserWorkerStub | undefined

  onmessage: ((event: MessageEvent<ApngParserWorkerOutput>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly postMessage = vi.fn((_message: unknown, _transfer?: Transferable[]) => undefined)
  readonly terminate = vi.fn()

  constructor() {
    ParserWorkerStub.latest = this
  }

  emit(data: ApngParserWorkerOutput): void {
    this.onmessage?.({ data } as MessageEvent<ApngParserWorkerOutput>)
  }
}

describe("APNG decode source", () => {
  it("rejects an aborted parse and lets a replacement complete independently", async () => {
    vi.stubGlobal("Worker", ParserWorkerStub)
    try {
      const source = new ApngDecodeSource({
        pool: { size: 1, submit: vi.fn(() => true) } as never,
        isStale: () => false,
        onFrameTotal: vi.fn(),
        memoryInput: false,
      })
      const first = source.parse(new File([], "first.png"), 1)
      const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" })
      const previous = ParserWorkerStub.latest!
      const replacement = source.parse(new File([], "second.png"), 2)
      await rejected
      expect(previous.terminate).toHaveBeenCalledOnce()
      expect(previous.onmessage).toBeNull()
      previous.emit({ type: "error", message: "late error" })
      ParserWorkerStub.latest!.emit({ type: "done", width: 2, height: 1, frames: 1, metadata })
      await replacement
      source.abort()
      expect(ParserWorkerStub.latest!.terminate).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
      ParserWorkerStub.latest = undefined
    }
  })

  it("settles cancellation before a standalone file read completes", async () => {
    vi.stubGlobal("Worker", ParserWorkerStub)
    try {
      let finishRead!: (bytes: ArrayBuffer) => void
      const file = new File([], "slow.png")
      vi.spyOn(file, "arrayBuffer").mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve
          }),
      )
      const source = new ApngDecodeSource({
        pool: { size: 1 } as never,
        isStale: () => false,
        onFrameTotal: vi.fn(),
        memoryInput: true,
      })
      const parsing = source.parse(file, 1)
      const rejected = expect(parsing).rejects.toMatchObject({ name: "AbortError" })
      source.abort()
      source.abort()
      await rejected
      finishRead(new ArrayBuffer(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ParserWorkerStub.latest!.postMessage).not.toHaveBeenCalled()
      expect(ParserWorkerStub.latest!.terminate).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
      ParserWorkerStub.latest = undefined
    }
  })

  it("forwards QR geometry metadata from the parser to the decode worker", async () => {
    vi.stubGlobal("Worker", ParserWorkerStub)
    try {
      const submit = vi.fn((_message: unknown, _transfer: Transferable[]) => true)
      const source = new ApngDecodeSource({
        pool: { size: 2, submit } as never,
        isStale: () => false,
        onFrameTotal: vi.fn(),
      })
      const parsing = source.parse(new File([], "part.qr.png"), 1)
      const parser = ParserWorkerStub.latest!
      const compressed = new Blob()

      parser.emit({
        type: "frame",
        compressed,
        width: 800,
        height: 400,
        metadata,
        index: 0,
        total: 1,
      })

      expect(submit).toHaveBeenCalledWith(
        {
          type: "apng-frame",
          id: 0,
          compressed,
          w: 800,
          h: 400,
          metadata,
          index: 0,
          total: 1,
        },
        [],
      )

      parser.emit({ type: "done", width: 800, height: 400, frames: 1, metadata })
      await parsing
    } finally {
      vi.unstubAllGlobals()
      ParserWorkerStub.latest = undefined
    }
  })

  it("transfers standalone APNG files and compressed frames as bytes", async () => {
    vi.stubGlobal("Worker", ParserWorkerStub)
    try {
      const submit = vi.fn((_message: unknown, _transfer: Transferable[]) => true)
      const source = new ApngDecodeSource({
        pool: { size: 1, submit } as never,
        isStale: () => false,
        onFrameTotal: vi.fn(),
        memoryInput: true,
      })
      const file = new File([Uint8Array.of(1, 2, 3)], "part.qr.png")
      const parsing = source.parse(file, 1)
      await vi.waitFor(() => expect(ParserWorkerStub.latest!.postMessage).toHaveBeenCalled())
      const parser = ParserWorkerStub.latest!
      const [startMessage, startTransfer] = parser.postMessage.mock.calls[0]
      const start = startMessage as { type: string; data: ArrayBuffer; credits: number }

      expect(start).toMatchObject({ type: "startBytes", credits: 1 })
      expect(start.data).toBeInstanceOf(ArrayBuffer)
      expect(startTransfer).toEqual([start.data])

      const compressed = Uint8Array.of(4, 5, 6)
      parser.emit({ type: "frame", compressed, width: 2, height: 1, metadata, index: 0, total: 1 })
      expect(submit.mock.calls[0][1]).toEqual([compressed.buffer])

      parser.emit({ type: "done", width: 2, height: 1, frames: 1, metadata })
      await parsing
    } finally {
      vi.unstubAllGlobals()
      ParserWorkerStub.latest = undefined
    }
  })
})
