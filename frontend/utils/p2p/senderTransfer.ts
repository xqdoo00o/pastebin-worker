import { ensureXXHashReady } from "../../wasm/xxhash-loader.js"
import { asError, FileReadError } from "../errors.js"
import { createSpeedTracker, sendData, streamBlobToDataChannel } from "./transfer.js"
import {
  appendHashData,
  createBlockHashState,
  disposeHashData,
  finishHashData,
  maxVerificationRepairAttempts,
  verificationHashIndices,
  type BlockHashState,
} from "./verification.js"
import { verificationBlockSize } from "./protocol.js"
import {
  invalidateSenderPeerOperation,
  isPeerPaused,
  isPeerSending,
  isPeerVerifying,
  transitionPeer,
  type SenderFileVersion,
  type SenderPeerState,
} from "./senderState.js"
import type { SenderVerificationService } from "./senderVerification.js"

interface SenderPeerTransferOptions {
  peers: Map<string, SenderPeerState>
  verification: SenderVerificationService
  onError: (error: Error) => void
  syncWakeLock: () => void
  emitPeers: () => void
  switchPeerVersion: (peer: SenderPeerState, version: SenderFileVersion) => void
}

/** Owns byte streaming and verification repair for one sender's peer set. */
export class SenderPeerTransferService {
  constructor(private readonly options: SenderPeerTransferOptions) {}

  async send(peer: SenderPeerState, version: SenderFileVersion, rawOffset: number): Promise<void> {
    if (!peer.isPairAuthorized || peer.dc.readyState !== "open") return
    const operationGeneration = invalidateSenderPeerOperation(peer)
    const isCurrentOperation = () =>
      peer.operationGeneration === operationGeneration && this.options.peers.get(peer.peerId) === peer
    const { file: activeFile, verifyTransfer } = version
    const offset = Math.min(Math.max(Math.floor(rawOffset || 0), 0), activeFile.size)
    this.options.switchPeerVersion(peer, version)
    transitionPeer(peer, { kind: "uploading" })
    peer.speedBytesPerSecond = 0
    peer.progressTracker = createSpeedTracker(offset)
    peer.status = offset > 0 ? "Resuming transfer..." : "Sending file..."
    this.reportState()
    const manifestProducer =
      verifyTransfer && offset === 0 ? this.options.verification.reserveStreamed(version) : undefined
    const streamedHashState: BlockHashState | undefined = manifestProducer ? createBlockHashState() : undefined

    try {
      if (verifyTransfer) await ensureXXHashReady()
      let queuedBytes = offset
      const completed = await streamBlobToDataChannel({
        blob: activeFile.slice(offset),
        channel: peer.dc,
        chunkSize: this.options.verification.chunkSize(peer),
        shouldContinue: () => isCurrentOperation() && isPeerSending(peer),
        onReaderChange: (reader, active) => {
          if (active) peer.activeReader = reader
          else if (peer.activeReader === reader) peer.activeReader = undefined
        },
        onChunkSent: async (chunk) => {
          queuedBytes += chunk.byteLength
          if (streamedHashState) await appendHashData(streamedHashState, chunk)
        },
        mapReadError: (cause) => new FileReadError(activeFile.name, cause),
      })

      if (
        completed &&
        isCurrentOperation() &&
        !isPeerPaused(peer) &&
        queuedBytes >= activeFile.size &&
        peer.dc.readyState === "open"
      ) {
        if (verifyTransfer) {
          if (streamedHashState && manifestProducer) {
            const hashes = finishHashData(streamedHashState)
            this.options.verification.publishStreamed(version, manifestProducer, {
              blockSize: verificationBlockSize,
              hashes,
            })
          }
          const verification = await this.options.verification.manifest(version)
          if (!isCurrentOperation() || isPeerPaused(peer) || peer.dc.readyState !== "open") return
          if (!(await this.options.verification.sendManifest(peer, verification, isCurrentOperation))) return
          transitionPeer(peer, { kind: "verifying" })
          peer.status = "Waiting for receiver to verify..."
        } else {
          sendData(peer.dc, { type: "done" })
          peer.status = "Waiting for receiver to finish..."
        }
      }
    } catch (error) {
      if (!isCurrentOperation()) return
      const receivedError = asError(error)
      sendData(peer.dc, { type: "error", message: receivedError.message })
      this.options.onError(receivedError)
    } finally {
      disposeHashData(streamedHashState)
      if (manifestProducer) this.options.verification.cancelStreamed(version, manifestProducer)
      if (isCurrentOperation()) {
        if (isPeerSending(peer)) transitionPeer(peer, { kind: "idle" })
        this.reportState()
      }
    }
  }

  async resendBlocks(peer: SenderPeerState, indices: number[]): Promise<void> {
    if (!peer.isPairAuthorized || peer.dc.readyState !== "open" || !isPeerVerifying(peer)) return
    const version = peer.activeVersion
    if (!version?.verifyTransfer || !version.verificationManifest) return
    const { file: activeFile } = version
    const validIndices = verificationHashIndices(version.verificationManifest, indices)
    if (validIndices.length === 0) return
    if (peer.repairAttempts >= maxVerificationRepairAttempts) {
      sendData(peer.dc, { type: "error", message: "P2P verification repair limit reached." })
      return
    }
    peer.repairAttempts += 1
    const operationGeneration = invalidateSenderPeerOperation(peer)
    const isCurrentOperation = () =>
      peer.operationGeneration === operationGeneration && this.options.peers.get(peer.peerId) === peer
    peer.status = `Resending ${validIndices.length} verification block${validIndices.length === 1 ? "" : "s"}...`
    transitionPeer(peer, { kind: "repairing" })
    this.reportState()

    try {
      for (const index of validIndices) {
        if (!isCurrentOperation() || peer.dc.readyState !== "open") return
        const start = index * verificationBlockSize
        const end = Math.min(start + verificationBlockSize, activeFile.size)
        sendData(peer.dc, { type: "repair-start", index, size: end - start })
        const completed = await streamBlobToDataChannel({
          blob: activeFile.slice(start, end),
          channel: peer.dc,
          chunkSize: this.options.verification.chunkSize(peer),
          shouldContinue: isCurrentOperation,
          onReaderChange: (reader, active) => {
            if (active) peer.activeReader = reader
            else if (peer.activeReader === reader) peer.activeReader = undefined
          },
          mapReadError: (cause) => new FileReadError(activeFile.name, cause),
        })
        if (!completed || !isCurrentOperation()) return
        sendData(peer.dc, { type: "repair-end", index })
        this.options.emitPeers()
      }
      if (!isCurrentOperation()) return
      transitionPeer(peer, { kind: "verifying" })
      peer.status = "Waiting for receiver to verify..."
      this.reportState()
    } catch (error) {
      if (!isCurrentOperation()) return
      transitionPeer(peer, { kind: "idle" })
      this.options.syncWakeLock()
      const receivedError = asError(error)
      sendData(peer.dc, { type: "error", message: receivedError.message })
      this.options.onError(receivedError)
    }
  }

  private reportState(): void {
    this.options.syncWakeLock()
    this.options.emitPeers()
  }
}
