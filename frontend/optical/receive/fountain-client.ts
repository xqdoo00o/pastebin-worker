import { loadXXHashWasmModule } from "../../wasm/xxhash-loader.js"
import type { ExpectedOpticalTransfer, FountainWorkerOutput } from "../shared/fountain.js"
import { loadNanoRQCodecModule } from "../shared/wasm-module.js"
import { asError } from "../../utils/errors.js"
import { disposeWorker, WorkerInitialization } from "../../utils/workerLifecycle.js"
import type { PoolWorker } from "../shared/worker-pool.js"
import { createFountainWorker } from "./worker-factory.js"

const INIT_TIMEOUT_MS = 10_000

interface FountainWorkerClientOptions {
  onMessage: (message: Exclude<FountainWorkerOutput, { type: "processed" }>) => void
  onFatal: (message: string) => void
  isDone: () => boolean
}

export class FountainWorkerClient {
  private worker: Worker | undefined
  private ready: Promise<Worker> | undefined
  private initialization: WorkerInitialization<Worker> | undefined
  private nextConnectionId = 1
  private submittedFrames = 0
  private processedFrames = 0
  private expectedTransfer: ExpectedOpticalTransfer | null = null
  private readonly drainWaiters = new Set<() => void>()
  private readonly fullDrainWaiters = new Set<() => void>()

  constructor(private readonly options: FountainWorkerClientOptions) {}

  ensure(): Promise<Worker> {
    if (this.ready) return this.ready

    const initialization = new WorkerInitialization<Worker>()
    this.initialization = initialization
    const pending = initialization.promise
    this.ready = pending
    void Promise.all([loadNanoRQCodecModule(), loadXXHashWasmModule()])
      .then(([wasmModule, xxhashWasmModule]) => {
        if (!initialization.pending || this.initialization !== initialization) return
        const worker = createFountainWorker()
        this.worker = worker
        let initialized = false
        initialization.startTimeout(INIT_TIMEOUT_MS, () =>
          initialization.reject(new Error("Optical decoder worker initialization timed out")),
        )
        worker.onmessage = (event: MessageEvent<FountainWorkerOutput>) => {
          if (this.worker !== worker || (!initialized && !initialization.pending)) return
          const message = event.data
          if (message.type === "ready") {
            if (initialized) return
            try {
              worker.postMessage({ type: "expectTransfer", expected: this.expectedTransfer })
              initialized = true
              initialization.resolve(worker)
            } catch (error) {
              initialization.reject(asError(error))
            }
            return
          }
          if (!initialized && message.type === "error") {
            initialization.reject(new Error(message.message))
            return
          }
          if (message.type === "processed") {
            this.processedFrames += message.count
            this.notifyDrain()
            this.notifyFullDrain()
            return
          }
          this.options.onMessage(message)
        }
        const fail = (message: string) => {
          if (this.worker !== worker) return
          if (!initialized) initialization.reject(new Error(message))
          else if (!this.options.isDone()) this.options.onFatal(message)
        }
        worker.onerror = (event) => fail(`Optical decoder worker: ${event.message || "worker error"}`)
        worker.onmessageerror = () => fail("Optical decoder worker returned an unreadable message")
        worker.postMessage({ type: "init", wasmModule, xxhashWasmModule })
      })
      .catch((error: unknown) => initialization.reject(asError(error)))
    void pending.catch(() => {
      if (this.initialization !== initialization) return
      this.terminate()
    })
    return pending
  }

  connectDecodeWorker(worker: Worker, opticalCodecModule: WebAssembly.Module): PoolWorker {
    const fountain = this.worker
    if (!fountain) throw new Error("NanoRQ worker was not initialized")
    const channel = new MessageChannel()
    const connectionId = this.nextConnectionId++
    let connected = false
    try {
      fountain.postMessage({ type: "connect", connectionId, port: channel.port1 }, [channel.port1])
      connected = true
      worker.postMessage({ type: "init", wasmModule: opticalCodecModule, fountainPort: channel.port2 }, [channel.port2])
    } catch (error) {
      if (connected) {
        try {
          fountain.postMessage({ type: "disconnect", connectionId })
        } catch {
          // The worker is already unusable; continue cleaning up locally.
        }
      } else {
        channel.port1.close()
        channel.port2.close()
      }
      disposeWorker(worker)
      throw error
    }

    let disposed = false
    return Object.assign(worker, {
      dispose(): void {
        if (disposed) return
        disposed = true
        fountain.postMessage({ type: "disconnect", connectionId })
      },
    })
  }

  recordSubmitted(count: number): void {
    this.submittedFrames += count
  }

  expectTransfer(expected: ExpectedOpticalTransfer | undefined): void {
    this.expectedTransfer = expected ?? null
    this.worker?.postMessage({ type: "expectTransfer", expected: this.expectedTransfer })
  }

  waitForDrain(): Promise<void> {
    if (this.options.isDone() || this.processedFrames >= this.submittedFrames) return Promise.resolve()
    return new Promise((resolve) => this.drainWaiters.add(resolve))
  }

  /** Wait for every QR payload already submitted by retained decode workers.
   * Unlike waitForDrain(), completion does not short-circuit this barrier: it
   * separates two multipart stream identities that reuse the same workers. */
  waitForFullDrain(): Promise<void> {
    if (this.processedFrames >= this.submittedFrames) return Promise.resolve()
    return new Promise((resolve) => this.fullDrainWaiters.add(resolve))
  }

  terminate(): void {
    this.initialization?.reject(new DOMException("Optical decoder initialization was cancelled", "AbortError"))
    this.initialization = undefined
    if (this.worker) disposeWorker(this.worker)
    this.worker = undefined
    this.ready = undefined
    this.submittedFrames = 0
    this.processedFrames = 0
    this.resolveDrainWaiters()
    this.resolveFullDrainWaiters()
  }

  resetProgress(): void {
    this.submittedFrames = 0
    this.processedFrames = 0
    this.notifyDrain()
    this.notifyFullDrain()
  }

  private notifyDrain(): void {
    if (!this.options.isDone() && this.processedFrames < this.submittedFrames) return
    this.resolveDrainWaiters()
  }

  private notifyFullDrain(): void {
    if (this.processedFrames < this.submittedFrames) return
    this.resolveFullDrainWaiters()
  }

  private resolveDrainWaiters(): void {
    const waiters = Array.from(this.drainWaiters)
    this.drainWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private resolveFullDrainWaiters(): void {
    const waiters = Array.from(this.fullDrainWaiters)
    this.fullDrainWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}
