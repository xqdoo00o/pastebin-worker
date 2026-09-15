import { hashFileVerificationBlocks, verificationManifestMessages } from "./verification.js"
import { verificationBlockSize, type DataMessage, type P2PVerificationManifest } from "./protocol.js"
import { chunkSize, p2pControlMessageLengthLimit, waitForBufferedAmount } from "./transfer.js"
import {
  StreamedManifestUnavailableError,
  type SenderFileVersion,
  type SenderPeerState,
  type VerificationManifestProducer,
} from "./senderState.js"

const preferredChunkSize = 256 * 1024

/** Owns manifest production and control-channel delivery for sender file versions. */
export class SenderVerificationService {
  async manifest(version: SenderFileVersion): Promise<P2PVerificationManifest> {
    if (version.verificationManifest) return version.verificationManifest
    if (version.released) throw new DOMException("The file version was released.", "AbortError")
    const existingPromise = version.verificationManifestPromise
    if (existingPromise) {
      try {
        return await existingPromise
      } catch (error) {
        if (!(error instanceof StreamedManifestUnavailableError)) throw error
        return await this.manifest(version)
      }
    }

    const controller = new AbortController()
    version.verificationAbortController = controller
    const manifestPromise = (async () => {
      const hashes = await hashFileVerificationBlocks(version.file, controller.signal)
      const manifest = { blockSize: verificationBlockSize, hashes }
      version.verificationManifest = manifest
      return manifest
    })().finally(() => {
      if (version.verificationAbortController !== controller) return
      version.verificationAbortController = undefined
      if (!version.verificationManifest) version.verificationManifestPromise = undefined
    })
    version.verificationManifestPromise = manifestPromise
    return await manifestPromise
  }

  reserveStreamed(version: SenderFileVersion): VerificationManifestProducer | undefined {
    if (version.released || version.verificationManifest || version.verificationManifestPromise) return undefined
    let resolve!: (manifest: P2PVerificationManifest) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<P2PVerificationManifest>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    void promise.catch(() => undefined)
    const producer = { promise, resolve, reject }
    version.verificationManifestPromise = promise
    version.verificationManifestProducer = producer
    return producer
  }

  publishStreamed(
    version: SenderFileVersion,
    producer: VerificationManifestProducer,
    manifest: P2PVerificationManifest,
  ): void {
    if (version.verificationManifestProducer !== producer) return
    version.verificationManifest = manifest
    version.verificationManifestProducer = undefined
    version.verificationManifestPromise = undefined
    producer.resolve(manifest)
  }

  cancelStreamed(version: SenderFileVersion, producer: VerificationManifestProducer): void {
    if (version.verificationManifestProducer !== producer) return
    version.verificationManifestProducer = undefined
    version.verificationManifestPromise = undefined
    producer.reject(new StreamedManifestUnavailableError())
  }

  chunkSize(peer: SenderPeerState): number {
    const negotiated = peer.pc.sctp?.maxMessageSize
    if (negotiated === 0) return preferredChunkSize
    if (typeof negotiated === "number" && Number.isFinite(negotiated) && negotiated > 0) {
      return Math.max(1, Math.min(preferredChunkSize, Math.floor(negotiated)))
    }
    return chunkSize
  }

  async sendManifest(
    peer: SenderPeerState,
    manifest: P2PVerificationManifest,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const messageLengthLimit = p2pControlMessageLengthLimit(peer.pc.sctp?.maxMessageSize)
    const sendControlMessage = async (message: DataMessage): Promise<boolean> => {
      const raw = JSON.stringify(message)
      if (raw.length > messageLengthLimit) {
        throw new Error("The negotiated P2P control message limit is too small for transfer verification.")
      }
      await waitForBufferedAmount(peer.dc)
      if (!isCurrent() || peer.dc.readyState !== "open") return false
      peer.dc.send(raw)
      return true
    }

    for (const message of verificationManifestMessages(manifest, messageLengthLimit)) {
      if (!(await sendControlMessage(message))) return false
    }
    return true
  }
}
