import { P2P_RTC_DISCONNECT_GRACE_MS } from "../../../shared/constants.js"
import type { SignalMessage } from "./protocol.js"

interface ReceiverConnectionRecoveryOptions {
  initialRetryToken?: string
  isClosed: () => boolean
  isComplete: () => boolean
  isSignalingReady: () => boolean
  isSenderSignalingAvailable: () => boolean
  recoveryStatus: () => string
  waitingForSignalingStatus: () => string
  sendSignal: (message: SignalMessage) => boolean
  onStatus: (status: string) => void
  onRecoveringChange: (recovering: boolean) => void
  onRetryTokenChange: (token: string | undefined) => void
}

/** Owns receiver-side reconnect intent, retry tokens and grace-period timers. */
export class ReceiverConnectionRecovery {
  #timer: ReturnType<typeof setTimeout> | undefined
  #requestSent = false
  #recovering = false
  #retryToken: string | undefined

  constructor(private readonly options: ReceiverConnectionRecoveryOptions) {
    this.#retryToken = options.initialRetryToken
  }

  get active(): boolean {
    return this.#recovering
  }

  get retryToken(): string | undefined {
    return this.#retryToken
  }

  setRetryToken(token: string | undefined): void {
    if (this.#retryToken === token) return
    this.#retryToken = token
    this.options.onRetryTokenChange(token)
  }

  begin(): void {
    this.#setRecovering(true)
  }

  defer(): void {
    this.#cancelTimer()
    this.#requestSent = false
  }

  retryNow(): void {
    this.#requestSent = false
    this.request(true)
  }

  request(immediate = false): void {
    if (this.options.isClosed() || this.options.isComplete()) return
    this.#setRecovering(true)
    this.options.onStatus(this.options.recoveryStatus())
    if (this.#requestSent) return
    if (this.#timer !== undefined) {
      if (!immediate) return
      this.#cancelTimer()
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        if (!this.options.isSignalingReady() || !this.options.isSenderSignalingAvailable()) {
          this.#requestSent = false
          this.options.onStatus(this.options.waitingForSignalingStatus())
          return
        }
        this.#requestSent = this.options.sendSignal({
          type: "peer-reconnect-request",
          ...(this.#retryToken ? { retryToken: this.#retryToken } : {}),
        })
      },
      immediate ? 0 : P2P_RTC_DISCONNECT_GRACE_MS,
    )
  }

  finish({ preserveRetryToken = false }: { preserveRetryToken?: boolean } = {}): void {
    this.defer()
    if (!preserveRetryToken) this.setRetryToken(undefined)
    this.#setRecovering(false)
  }

  dispose(preserveRetryToken = false): void {
    this.finish({ preserveRetryToken })
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #setRecovering(recovering: boolean): void {
    if (this.#recovering === recovering) return
    this.#recovering = recovering
    this.options.onRecoveringChange(recovering)
  }
}
