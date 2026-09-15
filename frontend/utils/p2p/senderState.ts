import { closeP2PConnection, type P2PIceCandidateBuffer } from "./rtc.js"
import {
  verificationBlockSize,
  type P2PConnectionRoute,
  type P2PFileCleanup,
  type P2PFileMeta,
  type P2PProgress,
  type P2PSenderFileInfo,
  type P2PSenderPeerInfo,
  type P2PTransferStatus,
  type P2PVerificationManifest,
} from "./protocol.js"
import type { P2PReconnectPolicy } from "./signalingTransport.js"
import { uuid, type SpeedTracker } from "./transfer.js"
import type { OriginalFileInfo } from "../../../shared/interfaces.js"
import type { P2PIceMode } from "./rtc.js"

export interface SenderFileVersion {
  revision: string
  order: number
  file: File
  highlightLanguage?: string
  originalFiles?: OriginalFileInfo[]
  verifyTransfer: boolean
  verificationManifest?: P2PVerificationManifest
  verificationManifestPromise?: Promise<P2PVerificationManifest>
  verificationManifestProducer?: VerificationManifestProducer
  verificationAbortController?: AbortController
  cleanup?: P2PFileCleanup
  released?: boolean
}

export interface VerificationManifestProducer {
  promise: Promise<P2PVerificationManifest>
  resolve: (manifest: P2PVerificationManifest) => void
  reject: (reason: unknown) => void
}

export class StreamedManifestUnavailableError extends Error {
  constructor() {
    super("The streamed verification manifest is unavailable.")
    this.name = "StreamedManifestUnavailableError"
  }
}

export type SenderTransferState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "paused" }
  | { kind: "verifying" }
  | { kind: "repairing" }
  | { kind: "complete" }

export type SenderRecoveryState = "idle" | "recovering" | "blocked"

export interface SenderPeerState {
  peerId: string
  userAgent?: string
  browser: string
  pc: RTCPeerConnection
  dc: RTCDataChannel
  iceCandidates: P2PIceCandidateBuffer
  negotiationId: string
  signalingConnectionId?: string
  status: string
  connectionRoute?: P2PConnectionRoute
  progress?: P2PProgress
  isConnected: boolean
  hasOpenedDataChannel: boolean
  isSignalingConnected: boolean
  isWaitingForResume: boolean
  recoveryState: SenderRecoveryState
  recoveryRetryToken?: string
  transferState: SenderTransferState
  isPairReported: boolean
  isPairAuthorized: boolean
  isMetaSent: boolean
  isCompletionReported: boolean
  operationGeneration: number
  activeReader?: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>
  speedBytesPerSecond: number
  progressTracker?: SpeedTracker
  activeVersion?: SenderFileVersion
  repairAttempts: number
}

export interface SenderPeerRecovery {
  policy: P2PReconnectPolicy
  timer?: ReturnType<typeof setTimeout>
  isAttempting: boolean
  nextAttemptMode: P2PIceMode
}

export interface EnsurePeerOptions {
  preserveProgress?: boolean
  recovering?: boolean
  signalingConnectionId?: string
  iceMode?: P2PIceMode
}

interface SenderPeerVersionRefs {
  current?: SenderFileVersion
  offered?: SenderFileVersion
}

export function createFileVersion(
  file: File,
  verifyTransfer: boolean,
  order: number,
  highlightLanguage?: string,
  cleanup?: P2PFileCleanup,
  originalFiles?: OriginalFileInfo[],
): SenderFileVersion {
  return {
    revision: uuid(),
    order,
    file,
    highlightLanguage,
    originalFiles,
    verifyTransfer,
    cleanup,
    verificationManifest: file.size === 0 ? { blockSize: verificationBlockSize, hashes: [] } : undefined,
  }
}

function releaseFileVersion(version: SenderFileVersion): void {
  version.released = true
  version.verificationAbortController?.abort()
  version.verificationAbortController = undefined
  const producer = version.verificationManifestProducer
  if (producer) {
    version.verificationManifestProducer = undefined
    if (version.verificationManifestPromise === producer.promise) version.verificationManifestPromise = undefined
    producer.reject(new DOMException("The file version was released.", "AbortError"))
  }
  const cleanup = version.cleanup
  version.cleanup = undefined
  if (cleanup) void cleanup().catch(() => undefined)
}

/** Owns every retained file revision and its reconnect grace-period timers. */
export class SenderFileVersionRegistry {
  readonly #versions = new Map<string, SenderFileVersion>()
  readonly #peerRefs = new Map<string, SenderPeerVersionRefs>()
  readonly #peerCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #versionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #currentRevision: string

  constructor(
    initialVersion: SenderFileVersion,
    private readonly cleanupDelayMs: number,
  ) {
    this.#currentRevision = initialVersion.revision
    this.add(initialVersion)
  }

  add(version: SenderFileVersion): void {
    this.#versions.set(version.revision, version)
  }

  setCurrent(version: SenderFileVersion): void {
    this.add(version)
    this.#currentRevision = version.revision
  }

  get(revision: string): SenderFileVersion | undefined {
    return this.#versions.get(revision)
  }

  referencedPeerIds(): IterableIterator<string> {
    return this.#peerRefs.keys()
  }

  refsFor(peerId: string): SenderPeerVersionRefs {
    let refs = this.#peerRefs.get(peerId)
    if (!refs) {
      refs = {}
      this.#peerRefs.set(peerId, refs)
    }
    return refs
  }

  releasePeer(peerId: string): void {
    this.cancelScheduledPeerRelease(peerId)
    this.#peerRefs.delete(peerId)
    this.prune()
  }

  cancelScheduledPeerRelease(peerId: string): void {
    const timer = this.#peerCleanupTimers.get(peerId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#peerCleanupTimers.delete(peerId)
  }

  schedulePeerRelease(peerId: string, release: () => void): void {
    this.cancelScheduledPeerRelease(peerId)
    const timer = setTimeout(() => {
      this.#peerCleanupTimers.delete(peerId)
      release()
    }, this.cleanupDelayMs)
    this.#peerCleanupTimers.set(peerId, timer)
  }

  prune(): void {
    const retainedRevisions = this.#retainedRevisions()

    for (const revision of this.#versions.keys()) {
      const existingTimer = this.#versionCleanupTimers.get(revision)
      if (retainedRevisions.has(revision)) {
        if (existingTimer !== undefined) clearTimeout(existingTimer)
        this.#versionCleanupTimers.delete(revision)
        continue
      }
      if (existingTimer !== undefined) continue
      this.#versionCleanupTimers.set(
        revision,
        setTimeout(() => {
          this.#versionCleanupTimers.delete(revision)
          if (this.#retainedRevisions().has(revision)) return
          const version = this.#versions.get(revision)
          if (version) releaseFileVersion(version)
          this.#versions.delete(revision)
        }, this.cleanupDelayMs),
      )
    }
  }

  dispose(): void {
    for (const timer of this.#peerCleanupTimers.values()) clearTimeout(timer)
    for (const timer of this.#versionCleanupTimers.values()) clearTimeout(timer)
    this.#peerCleanupTimers.clear()
    this.#versionCleanupTimers.clear()
    this.#peerRefs.clear()
    for (const version of this.#versions.values()) releaseFileVersion(version)
    this.#versions.clear()
  }

  #retainedRevisions(): Set<string> {
    const revisions = new Set<string>([this.#currentRevision])
    for (const refs of this.#peerRefs.values()) {
      if (refs.current) revisions.add(refs.current.revision)
      if (refs.offered) revisions.add(refs.offered.revision)
    }
    return revisions
  }
}

export function fileMeta(version: SenderFileVersion, senderBrowser: string): P2PFileMeta {
  const { file, revision, highlightLanguage, originalFiles, verifyTransfer } = version
  return {
    revision,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    senderBrowser,
    originalFiles,
    highlightLanguage,
    verifyTransfer,
  }
}

export function senderFileInfo(version: SenderFileVersion): P2PSenderFileInfo {
  return { revision: version.revision, name: version.file.name, order: version.order }
}

export function senderTransferStatus(peer: SenderPeerState): P2PTransferStatus {
  if (peer.isWaitingForResume) return "WAITING"
  if (peer.recoveryState === "recovering" && peer.hasOpenedDataChannel && !isPeerPaused(peer)) return "RECONNECTING"
  switch (peer.transferState.kind) {
    case "complete":
      return "DONE"
    case "paused":
      return "PAUSED"
    case "repairing":
      return "REPAIRING"
    case "verifying":
      return "VERIFYING"
    case "uploading":
      return "UPLOADING"
    default:
      return "READY"
  }
}

export function senderConnectionPhase(peer: SenderPeerState): P2PSenderPeerInfo["connectionPhase"] {
  if (peer.recoveryState === "recovering") return peer.hasOpenedDataChannel ? "reconnecting" : "pairing-retry"
  if (peer.recoveryState === "blocked") return peer.hasOpenedDataChannel ? "reconnect-failed" : "pairing-failed"
  if (peer.isConnected) return "connected"
  return peer.hasOpenedDataChannel ? "disconnected" : "pairing"
}

export const isPeerComplete = (peer: SenderPeerState) => peer.transferState.kind === "complete"
export const isPeerPaused = (peer: SenderPeerState) => peer.transferState.kind === "paused"
export const isPeerSending = (peer: SenderPeerState) => peer.transferState.kind === "uploading"
export const isPeerVerifying = (peer: SenderPeerState) => peer.transferState.kind === "verifying"
const isPeerRepairing = (peer: SenderPeerState) => peer.transferState.kind === "repairing"
export const isPeerActive = (peer: SenderPeerState) =>
  isPeerSending(peer) || isPeerVerifying(peer) || isPeerRepairing(peer)

export function transitionPeer(peer: SenderPeerState, transferState: SenderTransferState): void {
  peer.transferState = transferState
}

export function invalidateSenderPeerOperation(peer: SenderPeerState): number {
  peer.operationGeneration += 1
  const reader = peer.activeReader
  peer.activeReader = undefined
  if (reader) void reader.cancel().catch(() => undefined)
  return peer.operationGeneration
}

export function closeSenderPeer(peer: SenderPeerState, preserveComplete = false, preserveResumable = false): boolean {
  const wasComplete = isPeerComplete(peer)
  invalidateSenderPeerOperation(peer)
  peer.isConnected = false
  closeP2PConnection(peer.pc, peer.dc)
  peer.recoveryState = "idle"
  if (preserveResumable && !wasComplete) {
    peer.isWaitingForResume = true
    if (peer.progress) peer.progress = { ...peer.progress, speedBytesPerSecond: 0 }
    transitionPeer(peer, { kind: "paused" })
    peer.status = "Disconnected. Waiting for receiver to resume."
    return true
  }
  peer.isWaitingForResume = false
  if (!preserveComplete || !wasComplete) {
    transitionPeer(peer, { kind: "idle" })
    return false
  }

  transitionPeer(peer, { kind: "complete" })
  peer.status = "Transfer complete."
  return true
}
