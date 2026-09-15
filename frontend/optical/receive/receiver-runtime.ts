import type { FountainSnapshot } from "../shared/fountain.js"
import type { ReceiverPhase } from "./camera.js"

export const NO_READABLE_APNG_QR_MESSAGE = "No readable QR symbols were found in this APNG file."

export type ReceiverTeardown = () => void | Promise<void>

/** Owns attempt identity and the teardown hooks shared by camera, screen and
 * APNG receives. Async work carries a generation token and cannot become
 * current again after reset, mode transition or page exit. */
export class ReceiverSession<Mode extends string> {
  private currentMode: Mode
  private currentGeneration = 0
  private stopped = false
  private delivered = false
  private readonly teardownHooks: ReceiverTeardown[] = []

  constructor(initialMode: Mode) {
    this.currentMode = initialMode
  }

  get mode(): Mode {
    return this.currentMode
  }

  get done(): boolean {
    return this.stopped
  }

  get attemptDelivered(): boolean {
    return this.delivered
  }

  beginAttempt(): number {
    this.currentGeneration += 1
    this.stopped = false
    this.delivered = false
    return this.currentGeneration
  }

  invalidate(): void {
    this.currentGeneration += 1
    this.stopped = true
    this.delivered = false
  }

  beginModeTransition(mode: Mode): number {
    this.currentMode = mode
    this.invalidate()
    return this.currentGeneration
  }

  isCurrentTransition(generation: number): boolean {
    return this.stopped && this.currentGeneration === generation
  }

  reset(): void {
    this.currentGeneration += 1
    this.stopped = false
    this.delivered = false
  }

  complete(): void {
    this.stopped = true
  }

  markDelivered(): void {
    this.delivered = true
  }

  isCurrent(mode: Mode, generation: number): boolean {
    return !this.stopped && this.currentMode === mode && this.currentGeneration === generation
  }

  addTeardown(hook: ReceiverTeardown): void {
    this.teardownHooks.push(hook)
  }

  async teardown(): Promise<void> {
    // Cleanup is best-effort but exhaustive: one browser API refusing release
    // must not prevent the remaining stream, workers or timers from stopping.
    await Promise.allSettled(this.teardownHooks.map((hook) => Promise.resolve().then(hook)))
  }
}

export interface ReceivedFileCleanup {
  cleanup: () => Promise<void>
  deferCleanup: () => void
}

/** Owns the browser URL and temporary storage attached to the rendered result. */
export class ReceivedFileResource {
  #cleanup: (() => Promise<void>) | undefined
  #deferCleanup: (() => void) | undefined
  #downloadStarted = false

  setStoredFile({ cleanup, deferCleanup }: ReceivedFileCleanup): void {
    this.#cleanup = cleanup
    this.#deferCleanup = deferCleanup
    this.#downloadStarted = false
  }

  markDownloadStarted(): void {
    this.#downloadStarted = true
  }

  release(): void {
    const cleanup = this.#cleanup
    const deferCleanup = this.#deferCleanup
    const downloadStarted = this.#downloadStarted
    this.#cleanup = undefined
    this.#deferCleanup = undefined
    this.#downloadStarted = false
    if (downloadStarted) deferCleanup?.()
    else if (cleanup) void cleanup().catch(() => undefined)
  }
}

/** Page-scoped mutable state for one optical receive runtime. */
export class OpticalReceiverRuntime {
  phase: ReceiverPhase = "idle"
  snapshot: FountainSnapshot | null = null
  apngFrameNumber = 0
  apngFrameTotal = 0
  #streamKey = ""
  #startedAt = 0
  #updateTimer: ReturnType<typeof setInterval> | undefined
  #rejectApngAttempt: ((error: Error) => void) | undefined

  applySnapshot(snapshot: FountainSnapshot, started: boolean, now = performance.now()): boolean {
    this.snapshot = snapshot
    if (!started && this.#streamKey === snapshot.identity) return false
    this.#streamKey = snapshot.identity
    this.#startedAt = now
    return true
  }

  elapsed(now = performance.now()): number {
    return Math.max(0, (now - this.#startedAt) / 1000)
  }

  resetTransfer(): void {
    this.snapshot = null
    this.#streamKey = ""
    this.#startedAt = 0
  }

  startUpdateTimer(callback: () => void): void {
    this.stopUpdateTimer()
    this.#updateTimer = setInterval(callback, 500)
  }

  stopUpdateTimer(): void {
    clearInterval(this.#updateTimer)
    this.#updateTimer = undefined
  }

  resetApngFrames(): void {
    this.apngFrameNumber = 0
    this.apngFrameTotal = 0
  }

  noteApngFrame(total: number): void {
    this.apngFrameNumber += 1
    this.apngFrameTotal = total
  }

  setApngAttemptRejector(reject: (error: Error) => void): void {
    this.#rejectApngAttempt = reject
  }

  rejectApngAttempt(error: Error): boolean {
    if (!this.#rejectApngAttempt) return false
    this.#rejectApngAttempt(error)
    return true
  }

  rejectUnreadableFirstApngFrame(index: number, forwardedSymbols: number): boolean {
    if (index !== 0 || forwardedSymbols !== 0) return false
    return this.rejectApngAttempt(new Error(NO_READABLE_APNG_QR_MESSAGE))
  }

  clearApngAttempt(): void {
    this.#rejectApngAttempt = undefined
  }
}
