import type { OriginalFileInfo, P2PIceServer, P2PUpdateResponse, PublicEnv } from "../../shared/interfaces.js"
import { browserLabel } from "./browser.js"
import { asError } from "./errors.js"
import { P2PIceCandidateBuffer, rtcConfig, refreshP2PConnectionRoute } from "./p2p/rtc.js"
import {
  type DataMessage,
  type P2PFileCleanup,
  type P2PSenderPeerInfo,
  type P2PSenderSession,
  type SignalMessage,
  parseP2PDataMessage,
} from "./p2p/protocol.js"
import {
  createP2PSignalingTransport,
  createP2PRoomRetryProbe,
  reconnectWindowMs,
  wsUrl,
  type P2PSignalingTransport,
} from "./p2p/signalingTransport.js"
import { P2PWakeLock } from "./p2p/wakeLock.js"
import { createSpeedTracker, measureSpeed, sendData, uuid } from "./p2p/transfer.js"
import { SenderPeerPresentation } from "./p2p/senderPresentation.js"
import {
  SenderFileVersionRegistry,
  closeSenderPeer,
  createFileVersion,
  fileMeta,
  invalidateSenderPeerOperation,
  isPeerActive,
  isPeerComplete,
  isPeerPaused,
  senderFileInfo,
  transitionPeer,
  type EnsurePeerOptions,
  type SenderFileVersion,
  type SenderPeerState,
} from "./p2p/senderState.js"
import { createP2PRoom, updateP2PRoom } from "./p2p/roomClient.js"
import { SenderPeerRecoveryCoordinator } from "./p2p/senderRecovery.js"
import { SenderVerificationService } from "./p2p/senderVerification.js"
import { SenderPeerTransferService } from "./p2p/senderTransfer.js"

export interface StartP2PSenderOptions {
  file: File
  config: PublicEnv
  expire: string
  maxTransfers: string
  verifyTransfer: boolean
  callbacks: {
    onStatus: (status: string) => void
    onPeersChange: (peers: P2PSenderPeerInfo[]) => void
    onIceServersChange?: (iceServers: P2PIceServer[] | undefined) => void
    onLimitReached?: () => void
    onError: (error: Error) => void
  }
  signal?: AbortSignal
  highlightLanguage?: string
  fileCleanup?: P2PFileCleanup
  isPrivate?: boolean
  originalFiles?: OriginalFileInfo[]
}

export async function startP2PSender({
  file,
  config,
  expire,
  maxTransfers,
  verifyTransfer,
  callbacks,
  signal,
  highlightLanguage,
  fileCleanup,
  isPrivate = false,
  originalFiles,
}: StartP2PSenderOptions): Promise<P2PSenderSession> {
  const response = await createP2PRoom(config, {
    expire,
    maxTransfers,
    isPrivate,
    signal,
  })
  const peers = new Map<string, SenderPeerState>()
  const wakeLock = new P2PWakeLock(callbacks.onStatus)
  const verificationService = new SenderVerificationService()
  let nextVersionOrder = 0
  const senderBrowser = browserLabel(navigator.userAgent)
  let currentVersion = createFileVersion(
    file,
    verifyTransfer,
    nextVersionOrder++,
    highlightLanguage,
    fileCleanup,
    originalFiles,
  )
  const versionRegistry = new SenderFileVersionRegistry(currentVersion, reconnectWindowMs)
  let iceServers: P2PIceServer[] | undefined
  let isClosed = false
  let isSignalingReady = false
  let probeRelayRoutesOnReady = false
  let wakeLockNeeded = false

  const releasePeerVersionRefs = (peerId: string) => {
    versionRegistry.cancelScheduledPeerRelease(peerId)
    const peer = peers.get(peerId)
    if (peer?.isConnected) return
    if (peer && !peer.isConnected && peer.pc.connectionState === "closed") {
      presentation.archive(peer)
      closeSenderPeer(peer)
      peers.delete(peerId)
    }
    versionRegistry.releasePeer(peerId)
    presentation.emitPeers()
    presentation.emitReceiverStatus()
  }

  const schedulePeerVersionCleanup = (peerId: string) => {
    versionRegistry.schedulePeerRelease(peerId, () => releasePeerVersionRefs(peerId))
  }

  const syncWakeLock = () => {
    const hasActiveTransfer = [...peers.values()].some(isPeerActive)
    if (hasActiveTransfer === wakeLockNeeded) return
    wakeLockNeeded = hasActiveTransfer
    if (wakeLockNeeded) void wakeLock.start()
    else void wakeLock.stop()
  }

  const sendSenderSignal = (message: SignalMessage) => {
    return signalingTransport.send(message)
  }

  const isPeerTransportUsable = (peer: SenderPeerState) =>
    peer.isConnected &&
    peer.dc.readyState === "open" &&
    peer.pc.connectionState !== "closed" &&
    peer.pc.connectionState !== "failed" &&
    peer.pc.connectionState !== "disconnected"

  const canNegotiatePeer = (peer: SenderPeerState) => isSignalingReady && peer.isSignalingConnected

  const sendPeerMeta = (peer: SenderPeerState) => {
    if (peer.isMetaSent || !peer.isPairAuthorized || isPeerComplete(peer) || peer.dc.readyState !== "open") return
    sendData(peer.dc, { type: "meta", meta: fileMeta(currentVersion, senderBrowser) })
    const refs = versionRegistry.refsFor(peer.peerId)
    if (!refs.current) refs.current = currentVersion
    else if (refs.current.revision !== currentVersion.revision) refs.offered = currentVersion
    peer.isMetaSent = true
    versionRegistry.prune()
  }

  const reportPeerPaired = (peer: SenderPeerState, force = false) => {
    if (isPeerComplete(peer) || (!force && peer.isPairReported)) return
    peer.isPairReported = sendSenderSignal({ type: "receiver-paired", peerId: peer.peerId })
  }

  const reportTransferComplete = (peer: SenderPeerState, force = false) => {
    if (!force && peer.isCompletionReported) return
    peer.isCompletionReported = sendSenderSignal({ type: "transfer-complete", peerId: peer.peerId })
  }

  const presentation = new SenderPeerPresentation({
    callbacks,
    currentVersion: () => currentVersion,
    isPeerTransportUsable,
    isSignalingReady: () => isSignalingReady,
    peers,
  })
  const archiveCompletedTransfer = (peer: SenderPeerState) => presentation.archive(peer)
  const emitPeers = () => presentation.emitPeers()
  const emitReceiverStatus = () => presentation.emitReceiverStatus()

  const switchPeerVersion = (peer: SenderPeerState, version: SenderFileVersion) => {
    if (peer.activeVersion?.revision !== version.revision) {
      presentation.archive(peer)
      peer.activeVersion = version
      transitionPeer(peer, { kind: "idle" })
      peer.progress = undefined
      peer.progressTracker = undefined
      peer.speedBytesPerSecond = 0
      peer.repairAttempts = 0
    }
    const refs = versionRegistry.refsFor(peer.peerId)
    refs.current = version
    if (refs.offered?.revision === version.revision) refs.offered = undefined
    versionRegistry.prune()
  }
  const peerTransfer = new SenderPeerTransferService({
    peers,
    verification: verificationService,
    onError: callbacks.onError,
    syncWakeLock,
    emitPeers,
    switchPeerVersion,
  })

  const recoveryCoordinator = new SenderPeerRecoveryCoordinator({
    peers,
    isClosed: () => isClosed,
    canNegotiate: canNegotiatePeer,
    renegotiate: async (peer, iceMode, isCurrent) => {
      await ensurePeer(peer.peerId, peer.userAgent, isCurrent, {
        preserveProgress: true,
        recovering: true,
        iceMode,
      })
    },
    sendSignal: sendSenderSignal,
    onStateChanged: () => {
      syncWakeLock()
      presentation.emitPeers()
      presentation.emitReceiverStatus()
    },
    onError: callbacks.onError,
  })

  const disconnectPeer = (
    peerId: string,
    preserveComplete = false,
    releaseVersionRefs = false,
    preserveResumable = false,
  ) => {
    recoveryCoordinator.cancel(peerId)
    const peer = peers.get(peerId)
    if (!peer) return
    if (releaseVersionRefs) presentation.archive(peer)
    if (!closeSenderPeer(peer, preserveComplete && !releaseVersionRefs, preserveResumable && !releaseVersionRefs)) {
      peers.delete(peerId)
    }
    if (releaseVersionRefs) versionRegistry.releasePeer(peerId)
    else versionRegistry.prune()
    syncWakeLock()
    presentation.emitPeers()
    presentation.emitReceiverStatus()
  }

  const disconnectAllPeers = (preserveComplete = false) => {
    recoveryCoordinator.dispose()
    for (const [peerId, peer] of peers.entries()) {
      if (!closeSenderPeer(peer, preserveComplete, preserveComplete && peer.isWaitingForResume)) {
        peers.delete(peerId)
      }
    }
    syncWakeLock()
    presentation.emitPeers()
  }

  const clearRetainedState = () => {
    recoveryCoordinator.dispose()
    versionRegistry.dispose()
    presentation.clear()
  }

  const markTransferLimitReached = () => {
    if (isClosed) return
    callbacks.onStatus("Receiver limit reached. Existing receivers can continue.")
    callbacks.onLimitReached?.()
  }

  const finishSenderRuntime = () => {
    isClosed = true
    disconnectAllPeers()
    void wakeLock.stop()
    signalingTransport.close()
    signal?.removeEventListener("abort", close)
    clearRetainedState()
  }

  const close = () => {
    if (isClosed) return
    sendSenderSignal({ type: "sender-leave" })
    finishSenderRuntime()
  }

  const probeRoomBeforeRetry = createP2PRoomRetryProbe(config, response.name, {
    shouldRun: () => !isClosed,
    onUnavailable: () => {
      close()
      callbacks.onStatus("P2P room is no longer available. Share session closed.")
    },
    onRetry: () => signalingTransport.restartReconnect(),
  })

  const updateFile = (
    nextFile: File,
    nextVerifyTransfer: boolean,
    nextHighlightLanguage?: string,
    cleanup?: P2PFileCleanup,
    originalFiles?: OriginalFileInfo[],
  ) => {
    if (isClosed) throw new Error("The P2P share session is closed.")
    currentVersion = createFileVersion(
      nextFile,
      nextVerifyTransfer,
      nextVersionOrder++,
      nextHighlightLanguage,
      cleanup,
      originalFiles,
    )
    versionRegistry.setCurrent(currentVersion)

    for (const peer of peers.values()) {
      if (!peer.isPairAuthorized || peer.dc.readyState !== "open") continue
      sendData(peer.dc, { type: "file-update", meta: fileMeta(currentVersion, senderBrowser) })
      const refs = versionRegistry.refsFor(peer.peerId)
      refs.current ??= peer.activeVersion
      refs.offered = currentVersion
      if (isPeerActive(peer) || isPeerPaused(peer)) {
        peer.status = "New file available. Current transfer continues."
      } else {
        peer.status = "File updated. Waiting for receiver."
      }
    }
    versionRegistry.prune()
    callbacks.onStatus("P2P file updated. Existing link is unchanged.")
    emitPeers()
    return senderFileInfo(currentVersion)
  }

  const updateRoomOptions = async (
    nextExpire: string,
    nextMaxTransfers: string,
    updateSignal?: AbortSignal,
  ): Promise<P2PUpdateResponse> => {
    if (isClosed) throw new Error("The P2P share session is closed.")
    const updated = await updateP2PRoom(config, response, {
      expire: nextExpire,
      maxTransfers: nextMaxTransfers,
      signal: updateSignal,
    })
    response.expireAt = updated.expireAt
    response.expirationSeconds = updated.expirationSeconds
    callbacks.onStatus(
      updated.joinable
        ? "P2P settings updated. Waiting for receivers..."
        : "P2P settings updated. No new receivers can join; existing transfers can continue.",
    )
    return updated
  }

  async function ensurePeer(
    peerId: string,
    userAgent?: string,
    isCurrent: () => boolean = () => !isClosed,
    options: EnsurePeerOptions = {},
  ) {
    if (!isCurrent()) return
    versionRegistry.cancelScheduledPeerRelease(peerId)
    const existingPeer = peers.get(peerId)
    if (
      existingPeer &&
      isPeerComplete(existingPeer) &&
      existingPeer.activeVersion?.revision === currentVersion.revision
    ) {
      emitPeers()
      emitReceiverStatus()
      return
    }
    const preserveExisting = existingPeer && (existingPeer.isWaitingForResume || options.preserveProgress)
    const resumableProgress = preserveExisting ? existingPeer.progress : undefined
    const resumableVersion = preserveExisting ? existingPeer.activeVersion : undefined
    const preservedPausedState = options.preserveProgress && existingPeer ? isPeerPaused(existingPeer) : false
    const hasOpenedDataChannel = existingPeer?.hasOpenedDataChannel ?? false
    const effectiveUserAgent = userAgent ?? existingPeer?.userAgent
    if (existingPeer && isPeerComplete(existingPeer)) archiveCompletedTransfer(existingPeer)
    if (existingPeer) {
      closeSenderPeer(existingPeer)
      peers.delete(peerId)
    }
    if (!isCurrent()) return
    const pc = new RTCPeerConnection(rtcConfig(iceServers, { mode: options.iceMode }))
    const dc = pc.createDataChannel("file", { ordered: true })
    const negotiationId = uuid()
    const peer: SenderPeerState = {
      peerId,
      userAgent: effectiveUserAgent,
      browser: browserLabel(effectiveUserAgent),
      pc,
      dc,
      iceCandidates: new P2PIceCandidateBuffer(),
      negotiationId,
      signalingConnectionId: options.signalingConnectionId ?? existingPeer?.signalingConnectionId,
      connectionRoute: hasOpenedDataChannel ? existingPeer?.connectionRoute : undefined,
      status: options.recovering
        ? hasOpenedDataChannel
          ? preservedPausedState
            ? "Paused. Reconnecting to receiver..."
            : "Reconnecting to receiver..."
          : "WebRTC pairing failed. Retrying..."
        : "Pairing...",
      isConnected: false,
      hasOpenedDataChannel,
      isSignalingConnected: true,
      isWaitingForResume: false,
      recoveryState: options.recovering === true ? "recovering" : "idle",
      recoveryRetryToken: existingPeer?.recoveryRetryToken,
      transferState: preservedPausedState ? { kind: "paused" } : { kind: "idle" },
      isPairReported: false,
      isPairAuthorized: false,
      isMetaSent: false,
      isCompletionReported: false,
      operationGeneration: 0,
      speedBytesPerSecond: 0,
      progress: resumableProgress,
      progressTracker: resumableProgress ? createSpeedTracker(resumableProgress.doneBytes) : undefined,
      activeVersion: resumableVersion,
      repairAttempts: existingPeer?.repairAttempts ?? 0,
    }
    peers.set(peerId, peer)
    const isPeerCurrent = () => !isClosed && peers.get(peerId) === peer
    const refreshConnectionRoute = () => {
      refreshP2PConnectionRoute(
        pc,
        (route) => {
          if (!isPeerCurrent() || peer.connectionRoute === route) return
          peer.connectionRoute = route
          emitPeers()
        },
        isPeerCurrent,
      )
    }
    emitPeers()
    emitReceiverStatus()

    pc.onicecandidate = (event) => {
      if (isPeerCurrent() && event.candidate) {
        sendSenderSignal({ type: "candidate", peerId, candidate: event.candidate.toJSON(), negotiationId })
      }
    }
    pc.oniceconnectionstatechange = () => {
      if (isPeerCurrent() && (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed")) {
        refreshConnectionRoute()
      }
    }
    pc.onconnectionstatechange = () => {
      if (!isPeerCurrent()) return
      if (isPeerComplete(peer)) {
        emitPeers()
        emitReceiverStatus()
        return
      }
      if (pc.connectionState === "connected") {
        recoveryCoordinator.cancel(peerId)
        reportPeerPaired(peer)
        refreshConnectionRoute()
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        recoveryCoordinator.schedule(peerId, { immediate: pc.connectionState === "failed" })
        return
      } else {
        emitPeers()
        return
      }
      emitPeers()
      emitReceiverStatus()
    }

    dc.binaryType = "arraybuffer"
    dc.onopen = () => {
      if (!isPeerCurrent()) return
      if (isPeerComplete(peer)) {
        emitPeers()
        emitReceiverStatus()
        return
      }
      recoveryCoordinator.cancel(peerId)
      peer.isConnected = true
      peer.hasOpenedDataChannel = true
      peer.isWaitingForResume = false
      peer.recoveryState = "idle"
      peer.recoveryRetryToken = undefined
      peer.status = isPeerPaused(peer)
        ? "Paused by receiver."
        : peer.isPairAuthorized
          ? "Receiver connected."
          : "Authorizing receiver..."
      reportPeerPaired(peer)
      sendPeerMeta(peer)
      refreshConnectionRoute()
      emitPeers()
      emitReceiverStatus()
    }
    dc.onclose = () => {
      if (!isPeerCurrent() || isPeerComplete(peer)) return
      recoveryCoordinator.schedule(peerId, { immediate: true })
    }
    dc.onerror = () => {
      if (!isPeerCurrent() || isPeerComplete(peer)) return
      recoveryCoordinator.schedule(peerId, { immediate: true })
    }
    dc.onmessage = (event) => {
      if (!isPeerCurrent()) return
      if (typeof event.data !== "string") return
      let message: DataMessage
      try {
        message = parseP2PDataMessage(event.data, "receiver")
      } catch (error) {
        callbacks.onError(asError(error))
        return
      }
      if (message.type === "download") {
        const version = message.revision ? versionRegistry.get(message.revision) : currentVersion
        if (version) void peerTransfer.send(peer, version, message.offset)
        else sendData(peer.dc, { type: "error", message: "The requested file version is no longer available." })
      }
      if (message.type === "progress") {
        const version = message.revision ? versionRegistry.get(message.revision) : peer.activeVersion || currentVersion
        if (!version) return
        if (message.revision && message.revision !== version.revision) return
        switchPeerVersion(peer, version)
        const { file: activeFile, verifyTransfer: verifyActiveTransfer } = version
        const doneBytes = Math.min(Math.max(Math.floor(message.doneBytes || 0), 0), activeFile.size)
        peer.progressTracker ??= createSpeedTracker(doneBytes)
        peer.speedBytesPerSecond = measureSpeed(peer.progressTracker, doneBytes, doneBytes >= activeFile.size)
        peer.progress = { doneBytes, totalBytes: activeFile.size, speedBytesPerSecond: peer.speedBytesPerSecond }
        if (doneBytes >= activeFile.size && !verifyActiveTransfer) {
          peer.status = "Waiting for receiver to finish..."
        } else if (doneBytes >= activeFile.size && verifyActiveTransfer) {
          transitionPeer(peer, { kind: "verifying" })
        }
        emitPeers()
      }
      if (message.type === "repair-request") {
        void peerTransfer.resendBlocks(peer, message.indices)
      }
      if (message.type === "verified") {
        const activeFile = peer.activeVersion?.file
        invalidateSenderPeerOperation(peer)
        transitionPeer(peer, { kind: "verifying" })
        peer.status = "Receiver verified. Finalizing transfer..."
        if (peer.progress && activeFile) {
          peer.progress = { ...peer.progress, doneBytes: activeFile.size, speedBytesPerSecond: 0 }
        }
        syncWakeLock()
        emitPeers()
      }
      if (message.type === "received") {
        const version = message.revision ? versionRegistry.get(message.revision) : peer.activeVersion
        if (!version || version !== peer.activeVersion) return
        invalidateSenderPeerOperation(peer)
        transitionPeer(peer, { kind: "complete" })
        peer.status = version.verifyTransfer ? "Transfer verified." : "Transfer complete."
        peer.progress = { doneBytes: version.file.size, totalBytes: version.file.size, speedBytesPerSecond: 0 }
        reportTransferComplete(peer)
        syncWakeLock()
        emitPeers()
      }
      if (message.type === "pause" && !isPeerComplete(peer)) {
        invalidateSenderPeerOperation(peer)
        transitionPeer(peer, { kind: "paused" })
        peer.speedBytesPerSecond = 0
        if (peer.progress) peer.progress = { ...peer.progress, speedBytesPerSecond: 0 }
        peer.status = "Paused by receiver."
        sendData(peer.dc, { type: "paused" })
        syncWakeLock()
        emitPeers()
      }
      if (message.type === "stop") {
        invalidateSenderPeerOperation(peer)
        transitionPeer(peer, { kind: "idle" })
        peer.speedBytesPerSecond = 0
        peer.progressTracker = undefined
        peer.progress = undefined
        peer.activeVersion = undefined
        peer.status = "Transfer terminated by receiver."
        sendData(peer.dc, { type: "stopped" })
        syncWakeLock()
        emitPeers()
      }
    }

    const offer = await pc.createOffer()
    if (!isCurrent() || peers.get(peerId) !== peer) return
    await pc.setLocalDescription(offer)
    if (!isCurrent() || peers.get(peerId) !== peer) return
    sendSenderSignal({
      type: "offer",
      peerId,
      sdp: offer,
      negotiationId,
      ...(options.iceMode === "direct" ? { directOnly: true } : {}),
    })
  }

  const markPeerSignalingDisconnected = (peer: SenderPeerState) => {
    peer.isSignalingConnected = false
    if (isPeerTransportUsable(peer) && peer.recoveryState !== "recovering" && !isPeerComplete(peer)) {
      peer.status = isPeerPaused(peer)
        ? "Paused by receiver. Signaling reconnecting..."
        : "Signaling interrupted. Transfer continues."
    }
  }

  const reconcileSignalingPeer = async (
    peerId: string,
    userAgent?: string,
    connectionId?: string,
    isCurrent: () => boolean = () => !isClosed,
    options: { probeRelayRoute?: boolean } = {},
  ) => {
    if (!isCurrent()) return
    const existing = peers.get(peerId)
    if (!existing) {
      await ensurePeer(peerId, userAgent, isCurrent, { signalingConnectionId: connectionId })
      return
    }

    versionRegistry.cancelScheduledPeerRelease(peerId)
    const signalingEndpointChanged = connectionId !== undefined && connectionId !== existing.signalingConnectionId
    existing.isSignalingConnected = true
    existing.signalingConnectionId = connectionId
    if (signalingEndpointChanged) recoveryCoordinator.resetPolicy(peerId)
    if (userAgent) {
      existing.userAgent = userAgent
      existing.browser = browserLabel(userAgent)
    }
    if (isPeerComplete(existing)) {
      reportTransferComplete(existing, true)
      emitPeers()
      return
    }
    if (isPeerTransportUsable(existing)) {
      if ((signalingEndpointChanged || options.probeRelayRoute) && existing.connectionRoute === "relay") {
        recoveryCoordinator.schedule(peerId, { immediate: true, resetBlocked: true })
        return
      }
      existing.status = isPeerPaused(existing)
        ? "Paused by receiver."
        : existing.isPairAuthorized
          ? "Receiver connected."
          : "Authorizing receiver..."
      reportPeerPaired(existing, true)
      sendPeerMeta(existing)
      emitPeers()
      emitReceiverStatus()
      return
    }
    if (signalingEndpointChanged) {
      recoveryCoordinator.schedule(peerId, { immediate: true, resetBlocked: true })
      return
    }
    if (existing.recoveryState === "blocked") {
      emitPeers()
      emitReceiverStatus()
      return
    }
    if (existing.recoveryState === "recovering" || recoveryCoordinator.has(peerId)) {
      recoveryCoordinator.schedule(peerId, { immediate: true })
      return
    }

    const preserveProgress = Boolean(existing.progress) || isPeerPaused(existing) || existing.isWaitingForResume
    await ensurePeer(peerId, userAgent, isCurrent, {
      preserveProgress,
      recovering: preserveProgress,
    })
  }

  async function addCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const peer = peers.get(peerId)
    if (!peer) return
    await peer.iceCandidates.addOrBuffer(peer.pc, candidate, () => !isClosed && peers.get(peerId) === peer)
  }

  async function flushCandidates(peer: SenderPeerState, isCurrent: () => boolean = () => !isClosed) {
    await peer.iceCandidates.flush(peer.pc, () => isCurrent() && peers.get(peer.peerId) === peer)
  }

  const signalingTransport: P2PSignalingTransport = createP2PSignalingTransport({
    url: wsUrl(config, response.name, "sender", { token: response.senderToken }),
    shouldReconnect: () => !isClosed,
    onOpen: (isReconnect) => {
      if (isReconnect) probeRelayRoutesOnReady = true
      callbacks.onStatus(isReconnect ? "P2P signaling reconnected. Synchronizing..." : "Waiting for receiver...")
    },
    onSocketError: () => {
      isSignalingReady = false
      recoveryCoordinator.deferUntilSignaling()
      emitReceiverStatus()
    },
    onClose: () => {
      isSignalingReady = false
      recoveryCoordinator.deferUntilSignaling()
      emitPeers()
      emitReceiverStatus()
    },
    onReconnectExhausted: () => {
      const hasRetainedTransfer = [...peers.values()].some(
        (peer) =>
          isPeerTransportUsable(peer) ||
          peer.recoveryState === "recovering" ||
          peer.isWaitingForResume ||
          isPeerComplete(peer) ||
          peer.progress !== undefined,
      )
      if (hasRetainedTransfer) {
        callbacks.onStatus(
          [...peers.values()].some(isPeerTransportUsable)
            ? "P2P signaling is still unavailable. Existing transfers continue while retrying."
            : "P2P signaling is still unavailable. Retrying to preserve resumable transfers...",
        )
        probeRoomBeforeRetry()
        return
      }
      finishSenderRuntime()
      callbacks.onStatus("Unable to restore P2P signaling. Share session closed.")
    },
    onImmediateMessage: (message) => {
      if (message.type === "transfer-limit-complete") {
        markTransferLimitReached()
        return true
      }
      if (message.type === "room-options-updated") {
        callbacks.onStatus(
          message.joinable
            ? "P2P settings updated. Waiting for receivers..."
            : "No new receivers can join. Existing receivers can continue.",
        )
        return true
      }
      return false
    },
    onMessage: async (message, isCurrentSocket) => {
      if (message.type === "ready") {
        const probeRelayRoutes = probeRelayRoutesOnReady
        probeRelayRoutesOnReady = false
        isSignalingReady = true
        signalingTransport.resetReconnect()
        if ("iceServers" in message) {
          iceServers = message.iceServers
          callbacks.onIceServersChange?.(iceServers)
        }
        const connectedReceiverIds = new Set(message.peers.receivers.map((receiver) => receiver.peerId))
        for (const peer of peers.values()) {
          if (!connectedReceiverIds.has(peer.peerId)) markPeerSignalingDisconnected(peer)
        }
        for (const receiver of message.peers.receivers) {
          if (!isCurrentSocket()) return
          await reconcileSignalingPeer(receiver.peerId, receiver.userAgent, receiver.connectionId, isCurrentSocket, {
            probeRelayRoute: probeRelayRoutes,
          })
        }
        for (const peer of peers.values()) {
          if (!isCurrentSocket()) return
          if (isPeerComplete(peer) && !connectedReceiverIds.has(peer.peerId)) reportTransferComplete(peer, true)
          if (peer.recoveryState === "recovering" && peer.isSignalingConnected) {
            recoveryCoordinator.schedule(peer.peerId, { immediate: true })
          }
        }
        for (const peerId of versionRegistry.referencedPeerIds()) {
          if (!connectedReceiverIds.has(peerId) && !peers.has(peerId)) {
            schedulePeerVersionCleanup(peerId)
          }
        }
        emitPeers()
        emitReceiverStatus()
      }
      if (message.type === "peer-joined" && message.role === "receiver" && message.peerId) {
        if ("iceServers" in message) {
          iceServers = message.iceServers
          callbacks.onIceServersChange?.(iceServers)
        }
        await reconcileSignalingPeer(message.peerId, message.userAgent, message.connectionId, isCurrentSocket)
      }
      if (message.type === "peer-signaling-disconnected" && message.role === "receiver" && message.peerId) {
        const peer = peers.get(message.peerId)
        if (peer) {
          if (
            message.connectionId &&
            peer.signalingConnectionId &&
            message.connectionId !== peer.signalingConnectionId
          ) {
            return
          }
          markPeerSignalingDisconnected(peer)
          recoveryCoordinator.deferUntilSignaling(message.peerId)
          emitPeers()
          emitReceiverStatus()
        }
      }
      if (message.type === "peer-reconnect-request" && message.peerId && isCurrentSocket()) {
        const peer = peers.get(message.peerId)
        if (!peer) return
        if (message.retryToken !== undefined) {
          if (message.retryToken !== peer.recoveryRetryToken) return
          recoveryCoordinator.schedule(message.peerId, { immediate: true, resetBlocked: true })
          return
        }
        if (peer.recoveryState !== "blocked") recoveryCoordinator.schedule(message.peerId, { immediate: true })
      }
      if (message.type === "answer") {
        const peer = peers.get(message.peerId)
        if (!peer || !isCurrentSocket() || (message.negotiationId && message.negotiationId !== peer.negotiationId))
          return
        await peer.pc.setRemoteDescription(message.sdp)
        if (!isCurrentSocket() || peers.get(message.peerId) !== peer) return
        await flushCandidates(peer, isCurrentSocket)
      }
      if (message.type === "candidate" && isCurrentSocket()) {
        const peer = peers.get(message.peerId)
        if (peer && (!message.negotiationId || message.negotiationId === peer.negotiationId)) {
          await addCandidate(message.peerId, message.candidate)
        }
      }
      if (message.type === "receiver-pair-result") {
        const peer = peers.get(message.peerId)
        if (!peer) return
        if (!message.accepted) {
          versionRegistry.cancelScheduledPeerRelease(message.peerId)
          disconnectPeer(message.peerId, false, true)
          return
        }
        peer.isPairAuthorized = true
        peer.status = isPeerPaused(peer)
          ? "Paused by receiver."
          : peer.recoveryState === "recovering"
            ? "Reconnecting to receiver..."
            : "Receiver connected."
        sendPeerMeta(peer)
        emitPeers()
        emitReceiverStatus()
      }
      if (message.type === "peer-left" && message.role === "receiver" && message.peerId) {
        if (message.resumable) {
          versionRegistry.cancelScheduledPeerRelease(message.peerId)
          disconnectPeer(message.peerId, true, false, true)
        } else {
          disconnectPeer(message.peerId, true)
          schedulePeerVersionCleanup(message.peerId)
        }
      }
    },
    onError: callbacks.onError,
  })

  signal?.throwIfAborted()
  signal?.addEventListener("abort", close, { once: true })
  signalingTransport.connect()

  return {
    response,
    get currentFile() {
      return senderFileInfo(currentVersion)
    },
    updateRoomOptions,
    updateFile,
    close,
  }
}
