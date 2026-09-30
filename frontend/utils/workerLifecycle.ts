/** Release callbacks and linked resources before terminating a worker.
 * Owners must settle their pending requests as part of the same shutdown. */
export function disposeWorker(
  worker: Pick<Worker, "onmessage" | "onerror" | "onmessageerror" | "terminate"> & { dispose?(): void },
): void {
  worker.onmessage = null
  worker.onerror = null
  worker.onmessageerror = null
  try {
    worker.dispose?.()
  } catch {
    // A broken side channel must not prevent the worker from terminating.
  }
  worker.terminate()
}
/** One initialization attempt, including cancellation and an optional ready timeout. */
export class WorkerInitialization<T> {
  readonly promise: Promise<T>
  private resolvePromise!: (value: T) => void
  private rejectPromise!: (error: Error) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private settled = false

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
  }

  get pending(): boolean {
    return !this.settled
  }

  startTimeout(milliseconds: number, onTimeout: () => void): void {
    if (this.settled) return
    clearTimeout(this.timer)
    this.timer = setTimeout(onTimeout, milliseconds)
  }

  resolve(value: T): void {
    if (!this.finish()) return
    this.resolvePromise(value)
  }

  reject(error: Error): void {
    if (!this.finish()) return
    this.rejectPromise(error)
  }

  private finish(): boolean {
    if (this.settled) return false
    this.settled = true
    clearTimeout(this.timer)
    this.timer = undefined
    return true
  }
}
