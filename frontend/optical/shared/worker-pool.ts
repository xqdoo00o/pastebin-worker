// Fixed-slot pool of decode workers.
//
// The subtle part is slot identity: every worker's message handler closes over
// its own index, so growing and shrinking the pool has to leave the surviving
// workers' indices alone. Shrinking from the end is what makes that true, and
// it is why this is worth having on its own rather than inline in the receiver.
//
// Each worker holds its own ~940 KB zxing WASM instance, so the pool is also
// how the receiver reclaims that memory the moment the last frame is in.

import type { DecodeWorkerOutput } from "./worker-messages.js"
import { asError } from "../../utils/errors.js"

export interface PoolWorker {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
  /** Release resources linked to this worker before terminating it. */
  dispose?(): void
  terminate(): void
}

const MAX_CONSECUTIVE_RESTARTS = 2
const WORKER_INITIALIZATION_TIMEOUT_MS = 10_000

export class DecodeWorkerPool {
  private readonly workers: PoolWorker[] = []
  private readonly busy: boolean[] = []
  private readonly stoppedWorkers = new WeakSet<PoolWorker>()
  private readonly initializationTimers = new WeakMap<PoolWorker, ReturnType<typeof setTimeout>>()
  private readonly idleWaiters = new Set<() => void>()
  private busyWorkers = 0

  constructor(
    private readonly create: () => PoolWorker,
    private readonly onCaptureError?: () => void,
    private readonly onWorkerError?: (error: Error) => void,
    private readonly onTaskComplete?: (output: DecodeWorkerOutput) => void,
    private readonly onTaskError?: (error: Error) => void,
  ) {}

  get size(): number {
    return this.workers.length
  }

  get busyCount(): number {
    return this.busyWorkers
  }

  /** Resolve on the next transition to no in-flight tasks. Callers that can
   * submit more work must stop doing so before awaiting this. */
  whenIdle(): Promise<void> {
    if (this.busyWorkers === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  /** Grow or shrink in place. Terminating a busy worker just drops the frame it
   *  held, which the fountain absorbs like any other miss. */
  resize(count: number): void {
    while (this.workers.length > Math.max(0, count)) {
      const worker = this.workers.pop()!
      this.stopWorker(worker)
      if (this.busy.pop()) this.busyWorkers--
    }
    while (this.workers.length < count) {
      const slot = this.workers.length
      try {
        this.workers.push(this.createWorker(slot, 0))
        this.busy.push(false)
      } catch (error) {
        this.failPool(error)
        return
      }
    }
    this.notifyIdle()
  }

  private createWorker(slot: number, restartCount: number): PoolWorker {
    const worker = this.create()
    const fail = (cause: unknown) => {
      if (this.workers[slot] !== worker) return
      const taskWasInFlight = this.busy[slot]
      this.release(slot)
      this.stopWorker(worker)

      const error = cause instanceof Error ? cause : new Error("QR decoder worker stopped unexpectedly.")
      if (taskWasInFlight) this.onTaskError?.(error)
      if (restartCount < MAX_CONSECUTIVE_RESTARTS) {
        try {
          this.workers[slot] = this.createWorker(slot, restartCount + 1)
          return
        } catch (replacementError) {
          this.failPool(replacementError)
          return
        }
      }
      this.failPool(error)
    }
    worker.onmessage = (event: MessageEvent) => {
      if (this.workers[slot] !== worker) return
      const output = event.data as DecodeWorkerOutput
      const { id, captureError } = output
      this.markWorkerInitialized(worker)
      if (id === -1) {
        if (output.error) fail(new Error(output.error))
        return // initialization/warm-up ping, no frame attached
      }
      restartCount = 0
      this.release(slot)
      if (captureError) this.onCaptureError?.()
      this.onTaskComplete?.(output)
    }
    worker.onerror = (event) => fail(event.error ?? new Error(event.message || "QR decoder worker error."))
    worker.onmessageerror = () => fail(new Error("QR decoder worker returned an unreadable message."))
    this.initializationTimers.set(
      worker,
      setTimeout(
        () => fail(new Error("QR decoder worker initialization timed out.")),
        WORKER_INITIALIZATION_TIMEOUT_MS,
      ),
    )
    return worker
  }

  private markWorkerInitialized(worker: PoolWorker): void {
    clearTimeout(this.initializationTimers.get(worker))
    this.initializationTimers.delete(worker)
  }

  private stopWorker(worker: PoolWorker): void {
    if (this.stoppedWorkers.has(worker)) return
    this.stoppedWorkers.add(worker)
    this.markWorkerInitialized(worker)
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    try {
      worker.dispose?.()
    } catch {
      // A broken side channel must not prevent the worker itself from terminating.
    }
    worker.terminate()
  }

  private release(slot: number): void {
    if (!this.busy[slot]) return
    this.busy[slot] = false
    this.busyWorkers--
    this.notifyIdle()
  }

  private notifyIdle(): void {
    if (this.busyWorkers !== 0 || this.idleWaiters.size === 0) return
    const waiters = Array.from(this.idleWaiters)
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  private failPool(cause: unknown): void {
    const error = asError(cause)
    this.resize(0)
    this.onWorkerError?.(error)
  }

  /** Hand a frame to a free worker. False when every worker is busy — the
   *  caller drops the frame rather than queueing it, because a stale frame is
   *  worth less than the next one. A synchronous transfer failure still throws,
   *  but only after releasing the reserved slot. */
  submit(message: unknown, transfer: Transferable[]): boolean {
    const slot = this.busy.indexOf(false)
    if (slot === -1) return false
    this.busy[slot] = true
    this.busyWorkers++
    try {
      this.workers[slot].postMessage(message, transfer)
    } catch (error) {
      this.busy[slot] = false
      this.busyWorkers--
      this.notifyIdle()
      throw error
    }
    return true
  }
}
