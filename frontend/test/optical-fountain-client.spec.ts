import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FountainWorkerClient } from "../optical/receive/fountain-client.js"

const dependencies = vi.hoisted(() => ({
  nano: vi.fn<() => Promise<WebAssembly.Module>>(),
  hash: vi.fn<() => Promise<WebAssembly.Module>>(),
  create: vi.fn<() => Worker>(),
}))
vi.mock("../optical/shared/wasm-module.js", () => ({ loadNanoRQCodecModule: dependencies.nano }))
vi.mock("../wasm/xxhash-loader.js", () => ({ loadXXHashWasmModule: dependencies.hash }))
vi.mock("../optical/receive/worker-factory.js", () => ({ createFountainWorker: dependencies.create }))

class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  ready(): void {
    this.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }))
  }
}

const wasm = {} as WebAssembly.Module
const clients: FountainWorkerClient[] = []
const workers: TestWorker[] = []

function createClient() {
  const callbacks = { onMessage: vi.fn(), onFatal: vi.fn(), isDone: () => false }
  const client = new FountainWorkerClient(callbacks)
  clients.push(client)
  return { client, callbacks }
}

beforeEach(() => {
  vi.useFakeTimers()
  dependencies.nano.mockReset().mockResolvedValue(wasm)
  dependencies.hash.mockReset().mockResolvedValue(wasm)
  dependencies.create.mockReset().mockImplementation(() => {
    const worker = new TestWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
})

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate()
  workers.length = 0
  vi.useRealTimers()
})

describe("fountain worker initialization", () => {
  it("cancels during codec loading without creating a worker and allows a fresh attempt", async () => {
    let release!: (module: WebAssembly.Module) => void
    dependencies.nano.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const { client } = createClient()
    const cancelled = expect(client.ensure()).rejects.toMatchObject({ name: "AbortError" })
    client.terminate()
    await cancelled
    expect(dependencies.create).not.toHaveBeenCalled()

    const next = client.ensure()
    await vi.advanceTimersByTimeAsync(0)
    workers[0].ready()
    await expect(next).resolves.toBe(workers[0])
    release(wasm)
    await vi.advanceTimersByTimeAsync(0)
    expect(dependencies.create).toHaveBeenCalledOnce()
    expect(workers[0].terminate).not.toHaveBeenCalled()
  })

  it("settles a cancelled handshake immediately and ignores a queued reply", async () => {
    const { client, callbacks } = createClient()
    const cancelled = expect(client.ensure()).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(0)
    const lateMessage = workers[0].onmessage!
    client.terminate()
    await cancelled
    lateMessage(new MessageEvent("message", { data: { type: "ready" } }))
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1)
    expect(callbacks.onMessage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reclaims a timed-out worker and retries with a new worker", async () => {
    const { client } = createClient()
    const timedOut = expect(client.ensure()).rejects.toThrow("initialization timed out")
    await vi.advanceTimersByTimeAsync(10_000)
    await timedOut
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const retry = client.ensure()
    await vi.advanceTimersByTimeAsync(0)
    workers[1].ready()
    await expect(retry).resolves.toBe(workers[1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects and cleans up if sending the initial transfer expectation fails", async () => {
    const { client } = createClient()
    const failed = expect(client.ensure()).rejects.toThrow("send failed")
    await vi.advanceTimersByTimeAsync(0)
    workers[0].postMessage.mockImplementation(() => {
      throw new Error("send failed")
    })
    workers[0].ready()
    await failed
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
