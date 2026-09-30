import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FountainWorkerInput, FountainWorkerOutput } from "../optical/shared/fountain.js"
import type { FramePart } from "../optical/shared/wire.js"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

async function startWorker() {
  vi.resetModules()
  let now = 0
  vi.spyOn(performance, "now").mockImplementation(() => now)
  const outputs: FountainWorkerOutput[] = []
  let acknowledge: (() => void) | undefined
  const scope = {
    onmessage: null as ((event: MessageEvent<FountainWorkerInput>) => void) | null,
    postMessage(message: FountainWorkerOutput) {
      outputs.push(message)
      if (message.type === "ready" || message.type === "processed") acknowledge?.()
    },
  }
  vi.stubGlobal("self", scope)
  await import("../optical/receive/fountain-worker.js")
  const dispatch = (data: FountainWorkerInput) => scope.onmessage!({ data } as MessageEvent<FountainWorkerInput>)
  await new Promise<void>((resolve) => {
    acknowledge = resolve
    dispatch({
      type: "init",
      wasmModule: readFileSync("frontend/optical/nanorq-codec/nanorq_codec_simd.wasm"),
      xxhashWasmModule: readFileSync("frontend/wasm/xxhash/xxhash_simd.wasm"),
    })
  })
  const port = { onmessage: null as ((event: MessageEvent) => void) | null, start: vi.fn() }
  dispatch({ type: "connect", connectionId: 1, port: port as unknown as MessagePort })
  const { RaptorQEncoder } = await import("../optical/shared/fountain.js")
  const { getXXH3, packFrame, inspectFrame, streamIdentity } = await import("../optical/shared/protocol.js")

  return {
    outputs,
    dispatch,
    async send(at: number, frames: Uint8Array[]) {
      now = at
      await new Promise<void>((resolve) => {
        acknowledge = resolve
        port.onmessage!({
          data: { type: "frames", buffers: frames.map((frame) => frame.slice().buffer) },
        } as MessageEvent)
      })
      expect(outputs.filter((message) => message.type === "error")).toEqual([])
    },
    async stream(symbolLen = 64, seed = 1, part: FramePart = { index: 0, count: 0, transferId: undefined }) {
      const payload = Uint8Array.from({ length: 2048 }, (_, index) => (index * 37 + seed) & 0xff)
      const header = { totalLen: payload.length, containerTag: await getXXH3(payload), part }
      const encoder = new RaptorQEncoder(payload, symbolLen)
      try {
        const frames = Array.from({ length: encoder.k + 16 }, (_, sequence) =>
          packFrame(header, encoder.encode(sequence)),
        )
        const inspected = inspectFrame(frames[0])
        if (!("frame" in inspected)) throw new Error("Invalid test frame")
        return { frames, payload, identity: streamIdentity(inspected.frame.header) }
      } finally {
        encoder.free()
      }
    },
  }
}

describe("optical fountain worker stream changes", () => {
  it.each(["B/frame", "file"])("recovers after changing %s halfway through reception", async (change) => {
    const worker = await startWorker()
    const old = await worker.stream()
    const next = await worker.stream(change === "B/frame" ? 128 : 64, change === "file" ? 2 : 1)

    await worker.send(0, old.frames.slice(0, 16))
    await worker.send(250, [old.frames[16]])
    expect(worker.outputs[worker.outputs.length - 2]).toMatchObject({ type: "progress", snapshot: { framesNew: 17 } })
    await worker.send(300, [next.frames[0]])
    expect(worker.outputs.filter((message) => message.type === "progress" && message.started)).toHaveLength(1)

    await worker.send(1250, [next.frames[1]])
    expect(worker.outputs[worker.outputs.length - 2]).toMatchObject({
      type: "progress",
      started: true,
      snapshot: { identity: next.identity, framesNew: 1, symbolLen: change === "B/frame" ? 128 : 64 },
    })
    // A late result from an old decode worker cannot switch the receiver back.
    await worker.send(1300, [old.frames[17]])
    await worker.send(1500, [next.frames[2]])
    expect(worker.outputs[worker.outputs.length - 2]).toMatchObject({
      type: "progress",
      started: false,
      snapshot: { framesNew: 2 },
    })
    await worker.send(1600, next.frames.slice(3))
    const completed = worker.outputs.filter((message) => message.type === "complete")
    expect(completed).toHaveLength(1)
    expect(completed[0].snapshot.identity).toBe(next.identity)
    expect(new Uint8Array(completed[0].container)).toEqual(next.payload)
    await worker.send(3000, next.frames)
    expect(worker.outputs.filter((message) => message.type === "complete")).toHaveLength(1)
  })

  it("preserves progress across pauses, duplicate frames and interleaved streams", async () => {
    const worker = await startWorker()
    const current = await worker.stream()
    const other = await worker.stream(128, 2)
    await worker.send(0, current.frames.slice(0, 16))
    for (const at of [800, 1600, 2400]) {
      await worker.send(at, [current.frames[0]])
      await worker.send(at + 100, [other.frames[0]])
    }
    expect(worker.outputs.filter((message) => message.type === "progress" && message.started)).toHaveLength(1)
    await worker.send(10_000, [current.frames[16]])
    expect(worker.outputs[worker.outputs.length - 2]).toMatchObject({
      type: "progress",
      started: false,
      snapshot: { identity: current.identity, framesNew: 17 },
    })
    await worker.send(10_100, current.frames.slice(17))
    const completed = worker.outputs.find((message) => message.type === "complete")
    expect(completed).toBeDefined()
    expect(new Uint8Array(completed!.container)).toEqual(current.payload)
  })

  it("keeps multipart routing and invalid-frame checks before replacing an idle stream", async () => {
    const worker = await startWorker()
    const part = { index: 1, count: 2, transferId: 123n }
    const current = await worker.stream(64, 1, part)
    const other = await worker.stream(64, 2)
    const next = await worker.stream(128, 1, part)
    worker.dispatch({ type: "expectTransfer", expected: { transferId: 123n, count: 2, missing: [1, 2] } })
    await worker.send(0, current.frames.slice(0, 16))
    await worker.send(2000, [new Uint8Array(3), ...other.frames])
    expect(worker.outputs.filter((message) => message.type === "progress" && message.started)).toHaveLength(1)
    expect(worker.outputs).toContainEqual(expect.objectContaining({ type: "verdict", reason: "transfer" }))
    await worker.send(2100, next.frames)
    expect(worker.outputs).toContainEqual({ type: "verdict", message: null })
    const completed = worker.outputs.find((message) => message.type === "complete")
    expect(completed?.part).toEqual(part)
    expect(new Uint8Array(completed!.container)).toEqual(next.payload)
  })
})
