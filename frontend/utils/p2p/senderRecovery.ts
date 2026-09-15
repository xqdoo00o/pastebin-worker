import { P2P_DIRECT_PROBE_TIMEOUT_MS, P2P_RTC_DISCONNECT_GRACE_MS } from "../../../shared/constants.js"
import { asError } from "../errors.js"
import { P2PReconnectPolicy } from "./signalingTransport.js"
import { uuid } from "./transfer.js"
import type { SignalMessage } from "./protocol.js"
import {
  invalidateSenderPeerOperation,
  isPeerComplete,
  isPeerPaused,
  transitionPeer,
  type SenderPeerRecovery,
  type SenderPeerState,
} from "./senderState.js"
import type { P2PIceMode } from "./rtc.js"

export interface ScheduleSenderPeerRecoveryOptions {
  immediate?: boolean
  resetBlocked?: boolean
}

interface SenderPeerRecoveryCoordinatorOptions {
  peers: Map<string, SenderPeerState>
  isClosed: () => boolean
  canNegotiate: (peer: SenderPeerState) => boolean
  renegotiate: (peer: SenderPeerState, iceMode: P2PIceMode, isCurrent: () => boolean) => Promise<void>
  sendSignal: (message: SignalMessage) => boolean
  onStateChanged: () => void
  onError: (error: Error) => void
}

/** Owns all sender-side WebRTC recovery policies and timers. */
export class SenderPeerRecoveryCoordinator {
  readonly #recoveries = new Map<string, SenderPeerRecovery>()

  constructor(private readonly options: SenderPeerRecoveryCoordinatorOptions) {}

  has(peerId: string): boolean {
    return this.#recoveries.has(peerId)
  }

  resetPolicy(peerId: string): void {
    this.#recoveries.get(peerId)?.policy.reset()
  }

  cancel(peerId: string): void {
    const recovery = this.#recoveries.get(peerId)
    if (!recovery) return
    if (recovery.timer !== undefined) clearTimeout(recovery.timer)
    this.#recoveries.delete(peerId)
  }

  dispose(): void {
    for (const peerId of [...this.#recoveries.keys()]) this.cancel(peerId)
  }

  deferUntilSignaling(peerId?: string): void {
    const peerIds = peerId === undefined ? [...this.#recoveries.keys()] : [peerId]
    for (const recoveringPeerId of peerIds) {
      const recovery = this.#recoveries.get(recoveringPeerId)
      if (!recovery) continue
      if (recovery.timer !== undefined) clearTimeout(recovery.timer)
      recovery.timer = undefined
      recovery.policy.reset()
    }
  }

  schedule(peerId: string, scheduleOptions: ScheduleSenderPeerRecoveryOptions = {}): void {
    const peer = this.options.peers.get(peerId)
    if (!peer || this.options.isClosed() || isPeerComplete(peer) || peer.isWaitingForResume) return
    if (peer.recoveryState === "blocked" && !scheduleOptions.resetBlocked) return
    if (scheduleOptions.resetBlocked) {
      peer.recoveryState = "idle"
      peer.recoveryRetryToken = undefined
      transitionPeer(peer, { kind: "idle" })
    }
    invalidateSenderPeerOperation(peer)
    peer.isConnected = false
    peer.recoveryState = "recovering"
    if (!isPeerPaused(peer)) transitionPeer(peer, { kind: "idle" })
    peer.speedBytesPerSecond = 0
    if (peer.progress) peer.progress = { ...peer.progress, speedBytesPerSecond: 0 }
    peer.status = peer.hasOpenedDataChannel
      ? isPeerPaused(peer)
        ? "Paused. Reconnecting to receiver..."
        : "Reconnecting to receiver..."
      : "WebRTC pairing failed. Retrying..."
    this.options.onStateChanged()

    let recovery = this.#recoveries.get(peerId)
    if (!recovery) {
      recovery = {
        policy: new P2PReconnectPolicy(),
        isAttempting: false,
        nextAttemptMode: peer.connectionRoute === "relay" ? "direct" : "all",
      }
      this.#recoveries.set(peerId, recovery)
    }
    if (recovery.isAttempting) return
    if (recovery.timer !== undefined) {
      if (!scheduleOptions.immediate) return
      clearTimeout(recovery.timer)
    }
    const scheduledRecovery = recovery
    scheduledRecovery.timer = setTimeout(
      () => {
        scheduledRecovery.timer = undefined
        void this.#attempt(peerId, scheduledRecovery)
      },
      scheduleOptions.immediate ? 0 : P2P_RTC_DISCONNECT_GRACE_MS,
    )
  }

  #fail(peerId: string, recovery: SenderPeerRecovery): void {
    if (this.#recoveries.get(peerId) !== recovery) return
    this.cancel(peerId)
    const peer = this.options.peers.get(peerId)
    if (!peer || isPeerComplete(peer) || peer.isWaitingForResume) return
    invalidateSenderPeerOperation(peer)
    peer.recoveryState = "blocked"
    peer.recoveryRetryToken = uuid()
    transitionPeer(peer, { kind: "paused" })
    peer.speedBytesPerSecond = 0
    if (peer.progress) peer.progress = { ...peer.progress, speedBytesPerSecond: 0 }
    peer.status = peer.hasOpenedDataChannel
      ? "Connection recovery failed. Waiting for receiver to retry."
      : "Unable to establish a WebRTC connection. Waiting for receiver to retry."
    this.options.sendSignal({ type: "peer-reconnect-failed", peerId, retryToken: peer.recoveryRetryToken })
    this.options.onStateChanged()
  }

  #scheduleNext(peerId: string, recovery: SenderPeerRecovery, minimumDelayMs = 0): void {
    if (this.#recoveries.get(peerId) !== recovery || recovery.timer !== undefined || recovery.isAttempting) return
    const peer = this.options.peers.get(peerId)
    if (!peer || !this.options.canNegotiate(peer)) return
    const policyDelay = recovery.policy.nextDelay()
    if (policyDelay === null) {
      this.#fail(peerId, recovery)
      return
    }
    recovery.timer = setTimeout(
      () => {
        recovery.timer = undefined
        void this.#attempt(peerId, recovery)
      },
      Math.max(policyDelay, minimumDelayMs),
    )
  }

  async #attempt(peerId: string, recovery: SenderPeerRecovery): Promise<void> {
    if (this.#recoveries.get(peerId) !== recovery || recovery.isAttempting || this.options.isClosed()) return
    const peer = this.options.peers.get(peerId)
    if (!peer || isPeerComplete(peer) || peer.isWaitingForResume) {
      this.cancel(peerId)
      return
    }
    if (!this.options.canNegotiate(peer)) return
    recovery.isAttempting = true
    const attemptMode = recovery.nextAttemptMode
    recovery.nextAttemptMode = "all"
    const isCurrent = () => !this.options.isClosed() && this.#recoveries.get(peerId) === recovery
    try {
      await this.options.renegotiate(peer, attemptMode, isCurrent)
    } catch (error) {
      this.options.onError(asError(error))
    } finally {
      recovery.isAttempting = false
    }
    const currentPeer = this.options.peers.get(peerId)
    if (isCurrent() && currentPeer && this.options.canNegotiate(currentPeer)) {
      this.#scheduleNext(peerId, recovery, attemptMode === "direct" ? P2P_DIRECT_PROBE_TIMEOUT_MS : 0)
    }
  }
}
