import { asError } from "../../utils/errors.js"
import { readFileBytes } from "../../utils/byteSource.js"
import type { DecodeWorkerPool } from "../shared/worker-pool.js"
import type { ApngParserWorkerOutput } from "../shared/worker-messages.js"
import { configuredWasmVariant } from "../shared/wasm-module.js"
import { createApngParserWorker } from "./worker-factory.js"

interface ApngDecodeSourceOptions {
  pool: DecodeWorkerPool
  isStale: (generation: number) => boolean
  onFrameTotal: (total: number) => void
  /** Standalone Blob workers cannot reliably read transferred File objects in
   * WebKit's opaque origin. Tests may also opt into this path explicitly. */
  memoryInput?: boolean
}

export class ApngDecodeSource {
  private worker: Worker | undefined
  private nextFrameId = 0

  constructor(private readonly options: ApngDecodeSourceOptions) {}

  parse(file: File, generation: number): Promise<void> {
    this.abort()
    this.nextFrameId = 0
    return new Promise((resolve, reject) => {
      const worker = createApngParserWorker()
      this.worker = worker
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        this.dispose(worker)
        if (error) reject(error)
        else resolve()
      }
      worker.onmessage = (event: MessageEvent<ApngParserWorkerOutput>) => {
        if (this.options.isStale(generation)) {
          settle(new Error("APNG decoding was cancelled."))
          return
        }
        const message = event.data
        if (message.type === "error") {
          settle(new Error(message.message))
          return
        }
        if (message.type === "done") {
          settle()
          return
        }
        this.options.onFrameTotal(message.total)
        try {
          const submitted = this.options.pool.submit(
            {
              type: "apng-frame",
              id: this.nextFrameId++,
              compressed: message.compressed,
              w: message.width,
              h: message.height,
              metadata: message.metadata,
              index: message.index,
              total: message.total,
            },
            message.compressed instanceof Uint8Array ? [message.compressed.buffer] : [],
          )
          if (!submitted) settle(new Error("The APNG parser exceeded the decode worker capacity."))
        } catch (error) {
          settle(asError(error))
        }
      }
      worker.onerror = (event) => settle(new Error(event.message || "The APNG parser worker stopped unexpectedly."))
      worker.onmessageerror = () => settle(new Error("The APNG parser worker returned an unreadable message."))
      const memoryInput = this.options.memoryInput ?? configuredWasmVariant !== "auto"
      if (!memoryInput) {
        try {
          worker.postMessage({ type: "start", file, credits: this.options.pool.size })
        } catch (error) {
          settle(asError(error))
        }
        return
      }
      void readFileBytes(file)
        .then((bytes) => {
          if (settled) return
          if (this.worker !== worker || this.options.isStale(generation)) {
            settle(new Error("APNG decoding was cancelled."))
            return
          }
          worker.postMessage({ type: "startBytes", data: bytes.buffer, credits: this.options.pool.size }, [
            bytes.buffer,
          ])
        })
        .catch((error) => settle(asError(error)))
    })
  }

  credit(): void {
    this.worker?.postMessage({ type: "credit" })
  }

  abort(): void {
    if (this.worker) this.dispose(this.worker)
  }

  private dispose(worker: Worker): void {
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    if (this.worker === worker) this.worker = undefined
  }
}
