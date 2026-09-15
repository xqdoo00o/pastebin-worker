import type { P2PSenderConnectionPhase, P2PSenderPeerInfo } from "./protocol.js"
import {
  isPeerComplete,
  isPeerPaused,
  senderConnectionPhase,
  senderFileInfo,
  senderTransferStatus,
  type SenderFileVersion,
  type SenderPeerState,
} from "./senderState.js"

interface SenderStatusPeer {
  connectionPhase: P2PSenderConnectionPhase
  isWaitingForResume: boolean
  isTransportUsable: boolean
  isSignalingConnected: boolean
}

const receiverCountText = (count: number) => `${count} Receiver${count === 1 ? "" : "s"}`

function senderReceiverStatus(peers: Iterable<SenderStatusPeer>, isSignalingReady: boolean): string {
  const phaseCounts: Record<P2PSenderConnectionPhase, number> = {
    pairing: 0,
    connected: 0,
    "pairing-retry": 0,
    reconnecting: 0,
    "pairing-failed": 0,
    "reconnect-failed": 0,
    disconnected: 0,
  }
  let transportUsableCount = 0
  let waitingResumeCount = 0
  let remoteSignalingInterruptedCount = 0
  for (const peer of peers) {
    phaseCounts[peer.connectionPhase] += 1
    if (peer.isWaitingForResume) waitingResumeCount += 1
    if (peer.isTransportUsable) {
      transportUsableCount += 1
      if (!peer.isSignalingConnected) remoteSignalingInterruptedCount += 1
    }
  }

  const connectedCount = phaseCounts.connected
  const pairingCount = phaseCounts.pairing
  const pairingRetryCount = phaseCounts["pairing-retry"]
  const reconnectingCount = phaseCounts.reconnecting
  const pairingFailedCount = phaseCounts["pairing-failed"]
  const recoveryFailedCount = phaseCounts["reconnect-failed"]

  if (!isSignalingReady) {
    return transportUsableCount > 0
      ? "P2P signaling disconnected. Existing transfers continue."
      : "P2P signaling closed. Reconnecting..."
  }

  if (reconnectingCount > 0 || pairingRetryCount > 0) {
    const parts: string[] = []
    if (reconnectingCount > 0) {
      parts.push(
        reconnectingCount === 1
          ? "Receiver connection interrupted. Reconnecting..."
          : `${receiverCountText(reconnectingCount)} reconnecting...`,
      )
    }
    if (pairingRetryCount > 0) {
      parts.push(
        pairingRetryCount === 1
          ? "WebRTC pairing failed. Retrying..."
          : `${receiverCountText(pairingRetryCount)} retrying WebRTC pairing...`,
      )
    }
    return parts.join(" ")
  }

  if (recoveryFailedCount > 0 || pairingFailedCount > 0) {
    const parts: string[] = []
    if (recoveryFailedCount > 0) {
      parts.push(
        recoveryFailedCount === 1
          ? "Connection recovery failed. Waiting for receiver to retry."
          : `${receiverCountText(recoveryFailedCount)} waiting to retry connection recovery.`,
      )
    }
    if (pairingFailedCount > 0) {
      parts.push(
        pairingFailedCount === 1
          ? "Unable to establish a WebRTC connection. Waiting for receiver to retry."
          : `${receiverCountText(pairingFailedCount)} failed WebRTC pairing and are waiting to retry.`,
      )
    }
    return parts.join(" ")
  }

  if (remoteSignalingInterruptedCount > 0) {
    return remoteSignalingInterruptedCount === 1
      ? "Receiver signaling interrupted. Existing transfer continues."
      : `${receiverCountText(remoteSignalingInterruptedCount)} signaling connections interrupted; transfers continue.`
  }
  if (connectedCount > 0 && pairingCount > 0) {
    return `${receiverCountText(connectedCount)} connected. ${receiverCountText(pairingCount)} pairing...`
  }
  if (pairingCount > 0) {
    return pairingCount === 1
      ? "Receiver found. Start WebRTC pairing..."
      : `${receiverCountText(pairingCount)} found. Start WebRTC pairing...`
  }
  if (connectedCount > 0 && waitingResumeCount > 0) {
    return `${receiverCountText(connectedCount)} connected. ${receiverCountText(waitingResumeCount)} waiting to resume.`
  }
  if (waitingResumeCount > 0) {
    return waitingResumeCount === 1
      ? "Receiver disconnected. Waiting for it to resume..."
      : `${receiverCountText(waitingResumeCount)} disconnected. Waiting for them to resume...`
  }
  return connectedCount === 0 ? "Waiting for receiver..." : `${receiverCountText(connectedCount)} connected.`
}

interface SenderPresentationCallbacks {
  onPeersChange: (peers: P2PSenderPeerInfo[]) => void
  onStatus: (status: string) => void
}

interface SenderPeerPresentationOptions {
  callbacks: SenderPresentationCallbacks
  currentVersion: () => SenderFileVersion
  isPeerTransportUsable: (peer: SenderPeerState) => boolean
  isSignalingReady: () => boolean
  peers: Map<string, SenderPeerState>
}

/** Derives UI-facing sender state while retaining completed transfers by file revision. */
export class SenderPeerPresentation {
  readonly #completed = new Map<string, P2PSenderPeerInfo>()

  constructor(private readonly options: SenderPeerPresentationOptions) {}

  archive(peer: SenderPeerState): void {
    if (!isPeerComplete(peer) || !peer.activeVersion) return
    this.#completed.set(`${peer.activeVersion.revision}:${peer.peerId}`, this.info(peer))
  }

  emitPeers(): void {
    this.options.callbacks.onPeersChange([
      ...this.#completed.values(),
      ...Array.from(this.options.peers.values(), (peer) => this.info(peer)),
    ])
  }

  emitReceiverStatus(): void {
    this.options.callbacks.onStatus(
      senderReceiverStatus(
        Array.from(this.options.peers.values(), (peer) => ({
          connectionPhase: senderConnectionPhase(peer),
          isWaitingForResume: peer.isWaitingForResume,
          isTransportUsable: this.options.isPeerTransportUsable(peer),
          isSignalingConnected: peer.isSignalingConnected,
        })),
        this.options.isSignalingReady(),
      ),
    )
  }

  clear(): void {
    this.#completed.clear()
  }

  private info(peer: SenderPeerState): P2PSenderPeerInfo {
    return {
      peerId: peer.peerId,
      file: senderFileInfo(peer.activeVersion || this.options.currentVersion()),
      browser: peer.browser,
      status: peer.status,
      connectionPhase: senderConnectionPhase(peer),
      connectionRoute: peer.connectionRoute,
      transferStatus: senderTransferStatus(peer),
      progress: peer.progress,
      isConnected: peer.isConnected,
      isWaitingForResume: peer.isWaitingForResume,
      isPaused: isPeerPaused(peer),
      isComplete: isPeerComplete(peer),
    }
  }
}
