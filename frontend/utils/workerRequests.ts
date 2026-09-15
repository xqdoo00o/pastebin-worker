import { asError } from "./errors.js"

interface PendingRequest<Value> {
  resolve(value: Value): void
  reject(error: Error): void
}

/** Correlates id-based Worker replies and guarantees pending requests can be
 * rejected together when their Worker is closed or becomes unusable. */
export class WorkerRequestMap<Value> {
  private readonly pending = new Map<number, PendingRequest<Value>>()
  private nextId = 1

  request(send: (id: number) => void, onSendError?: (error: Error) => void): Promise<Value> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        send(id)
      } catch (cause) {
        this.pending.delete(id)
        const error = asError(cause)
        onSendError?.(error)
        reject(error)
      }
    })
  }

  resolve(id: number, value: Value): boolean {
    const request = this.take(id)
    if (!request) return false
    request.resolve(value)
    return true
  }

  reject(id: number, error: Error): boolean {
    const request = this.take(id)
    if (!request) return false
    request.reject(error)
    return true
  }

  rejectAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }

  private take(id: number): PendingRequest<Value> | undefined {
    const request = this.pending.get(id)
    if (request) this.pending.delete(id)
    return request
  }
}
