import type { P2PIceServer, PublicEnv } from "../../shared/interfaces.js"
import { P2P_SIGNAL_RECONNECT_GRACE_MS, P2P_RECEIVER_SIGNAL_RECONNECT_WINDOW_MS } from "../../shared/constants.js"
import { asError } from "./errors.js"
import {
  P2PIceCandidateBuffer,
  closeP2PConnection,
  refreshP2PConnectionRoute,
  rtcConfig,
  type P2PIceMode,
} from "./p2p/rtc.js"
import { maxVerificationRepairAttempts, verificationBlockByteLength } from "./p2p/verification.js"
import {
  type P2PConnectionRoute,
  type P2PFileMeta,
  type P2PProgress,
  type P2PReceiverCallbacks,
  type P2PReceiverSession,
  type P2PVerificationManifest,
  type SignalMessage,
  parseP2PDataMessage,
  verificationBlockSize,
} from "./p2p/protocol.js"
import {
  createP2PSignalingTransport,
  createP2PRoomRetryProbe,
  wsUrl,
  type P2PSignalingTransport,
} from "./p2p/signalingTransport.js"
import { P2PWakeLock } from "./p2p/wakeLock.js"
import { createSpeedTracker, measureSpeed, progressUpdateIntervalMs, sendData } from "./p2p/transfer.js"
import { ensureXXHashReady } from "../wasm/xxhash-loader.js"
import { acquireP2PReceiverRoomLock, p2pResumeMetaMatches, setP2PSessionRecoveryRetryToken } from "./p2pReceiveStore.js"
import { MAX_MEMORY_P2P_BYTES } from "./p2p/receivedStorage.js"
import {
  createReceiverSessionIdentity,
  ReceiverTransferLifecycle,
  type ReceiverTransferState,
  rotateReceiverSessionPeer,
} from "./p2p/receiverSession.js"
import { ReceiverConnectionRecovery } from "./p2p/receiverRecovery.js"
import { ReceiverStorageCoordinator } from "./p2p/receiverStorageCoordinator.js"
import { ReceiverVerificationState } from "./p2p/receiverVerification.js"
import { ReceiverDataChannel } from "./p2p/receiverDataChannel.js"
import type { WebLockLease } from "./webLock.js"

const maxIncompleteTransferRetries = 3

export function startP2PReceiver(name: string, config: PublicEnv, callbacks: P2PReceiverCallbacks): P2PReceiverSession {
  const receiverIdentity = createReceiverSessionIdentity(name)
  const {
    checkpoint: initialResumeCheckpoint,
    initialRecoveryRetryToken,
    peerId,
    storage: receivedStorage,
  } = receiverIdentity
  const wakeLock = new P2PWakeLock(callbacks.onStatus)
  let pc: RTCPeerConnection | undefined
  const dataChannel = new ReceiverDataChannel()
  let connectionRoute: P2PConnectionRoute | undefined
  let iceServers: P2PIceServer[] | undefined
  let meta: P2PFileMeta | undefined
  let pendingUpdateMeta: P2PFileMeta | undefined
  let receivedBytes = 0
  const transfer = new ReceiverTransferLifecycle()
  let senderLeft = false
  let isClosed = false
  let hasCompletedTransfer = false
  let closeCleanupStarted = false
  let downloadRequestedChannel: RTCDataChannel | undefined
  let speedTracker = createSpeedTracker(0)
  const iceCandidates = new P2PIceCandidateBuffer()
  let negotiationId: string | undefined
  let lastProgressAt = 0
  const verificationState = new ReceiverVerificationState()
  let forceMemoryStorage = false
  let roomLock: WebLockLease | undefined
  let ownsRoomSession = false
  let isSignalingReady = false
  let senderSignalingAvailable = false
  let stoppedTransferCleanup: Promise<void> | undefined

  const releaseRoomLock = () => {
    roomLock?.release()
    roomLock = undefined
  }

  const rotatePeerIdForNextSession = () => {
    rotateReceiverSessionPeer(name)
  }

  const isComplete = () => transfer.isComplete()
  const isDiscarding = () => transfer.isDiscarding()
  const wantsDownload = () => transfer.wantsDownload()
  const isPaused = () => transfer.isPaused()
  const isPausePending = () => transfer.isPausePending()
  const restartAfterStop = () => transfer.shouldRestartAfterStop()
  const transitionTransfer = (next: ReceiverTransferState) => transfer.transition(next)

  const clearPauseState = () => {
    if (transfer.isPaused() || transfer.isPausePending()) transfer.transition({ kind: "idle" })
    callbacks.onPausedChange(false)
    callbacks.onPausePendingChange?.(false)
  }

  const confirmPause = () => {
    if (!transfer.isPausePending() || transfer.isComplete() || transfer.isDiscarding()) return
    transfer.transition({ kind: "paused" })
    callbacks.onPausePendingChange?.(false)
    callbacks.onPausedChange(true)
    callbacks.onStatus("Paused.")
    if (meta) {
      callbacks.onProgress({ doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
      if (dataChannel.current?.readyState === "open") {
        sendData(dataChannel.current, { type: "progress", doneBytes: receivedBytes, revision: meta.revision })
      }
      void storageCoordinator.enqueue(() => checkpointReceivedData(true)).catch(callbacks.onError)
    }
    void wakeLock.stop()
  }

  const sendReceiverSignal = (message: SignalMessage) => {
    return signalingTransport.send(message)
  }

  const storageCoordinator = new ReceiverStorageCoordinator({
    roomName: name,
    peerId,
    storage: receivedStorage,
    checkpoint: initialResumeCheckpoint,
    sendSignal: sendReceiverSignal,
  })

  const connectionRecovery = new ReceiverConnectionRecovery({
    initialRetryToken: initialRecoveryRetryToken,
    isClosed: () => isClosed,
    isComplete,
    isSignalingReady: () => isSignalingReady,
    isSenderSignalingAvailable: () => senderSignalingAvailable,
    recoveryStatus: () =>
      isDiscarding()
        ? restartAfterStop()
          ? "Connection interrupted while switching files. Reconnecting..."
          : "Connection interrupted while terminating. Reconnecting..."
        : isPaused()
          ? "Paused. Reconnecting to the sender..."
          : "Peer connection interrupted. Reconnecting...",
    waitingForSignalingStatus: () =>
      isPaused()
        ? "Paused. Waiting for signaling before reconnecting..."
        : "Peer connection interrupted. Waiting for signaling to reconnect...",
    sendSignal: sendReceiverSignal,
    onStatus: callbacks.onStatus,
    onRecoveringChange: (recovering) => callbacks.onReconnectingChange?.(recovering),
    onRetryTokenChange: (token) => setP2PSessionRecoveryRetryToken(name, peerId, token),
  })

  const isPeerTransportUsable = () =>
    dataChannel.current?.readyState === "open" &&
    pc?.connectionState !== "closed" &&
    pc?.connectionState !== "failed" &&
    pc?.connectionState !== "disconnected"

  const clearReceivedData = () => {
    receivedBytes = 0
    lastProgressAt = 0
    verificationState.clear()
  }

  const resetReceivedData = () => storageCoordinator.reset(clearReceivedData)

  const beginStoppedTransferCleanup = () => {
    stoppedTransferCleanup ??= resetReceivedData()
    return stoppedTransferCleanup
  }

  const prepareReceivedStorage = async () => {
    if (meta) {
      await storageCoordinator.prepare(meta, forceMemoryStorage, () => receivedBytes === 0, clearReceivedData)
    }
  }

  const appendReceivedBlockData = async (chunk: ArrayBuffer) => {
    await storageCoordinator.enqueue(async () => {
      if (!meta) return
      await storageCoordinator.initialize(meta, forceMemoryStorage)
      // Persistent storage transfers this buffer to its worker, which detaches it.
      // Capture the length first so the durable receive offset cannot move backwards.
      const chunkByteLength = chunk.byteLength
      await verificationState.appendFileChunk(chunk)
      await storageCoordinator.append(receivedBytes, chunk)
      receivedBytes += chunkByteLength
      await checkpointReceivedData()
    })
  }

  const checkpointReceivedData = async (force = false) => {
    if (!meta) return
    await storageCoordinator.checkpointData(
      { meta, receivedBytes, completedHashes: verificationState.completedHashes() },
      force,
    )
  }

  const replaceReceivedBlock = (index: number, parts: ArrayBuffer[]) => storageCoordinator.replaceBlock(index, parts)

  const createReceivedFile = (fileMeta: P2PFileMeta): Promise<File> => storageCoordinator.file(fileMeta)

  const verifyReceivedBlocks = async (
    manifest: P2PVerificationManifest,
    indicesToVerify?: Iterable<number>,
    isCurrent: () => boolean = () => true,
  ): Promise<number[]> => {
    return await verificationState.mismatches(
      manifest,
      (index) => storageCoordinator.verificationParts(index),
      indicesToVerify,
      isCurrent,
    )
  }

  const finishVerifiedTransfer = async (status = "Transfer complete.", isCurrent: () => boolean = () => !isClosed) => {
    if (!meta) return
    const file = await createReceivedFile(meta)
    if (!isCurrent()) return
    if (file.size !== meta.size) {
      const message = `Stored P2P file size mismatch: expected ${meta.size} bytes, got ${file.size} bytes.`
      await failVerifiedTransfer(message, isCurrent)
      if (isCurrent()) callbacks.onError(new Error(message))
      return
    }
    verificationState.resetIncompleteRetries()
    hasCompletedTransfer = true
    transitionTransfer({ kind: "complete" })
    downloadRequestedChannel = undefined
    callbacks.onProgress({
      doneBytes: meta.size,
      totalBytes: meta.size,
      speedBytesPerSecond: measureSpeed(speedTracker, meta.size, true),
    })
    clearPauseState()
    callbacks.onStatus(status)
    callbacks.onFile(file)
    if (dataChannel.current) sendData(dataChannel.current, { type: "received", revision: meta.revision })
    void wakeLock.stop()
    storageCoordinator.clearCheckpoint()
    rotatePeerIdForNextSession()
    signalingTransport.reconsiderReconnect()
  }

  const failVerifiedTransfer = async (message: string, isCurrent: () => boolean = () => !isClosed) => {
    transitionTransfer({ kind: "idle" })
    downloadRequestedChannel = undefined
    await resetReceivedData()
    if (!isCurrent()) return
    speedTracker = createSpeedTracker(0)
    callbacks.onProgress(undefined)
    clearPauseState()
    callbacks.onStatus(`${message} Receive the file again to retry.`)
    void wakeLock.stop()
  }

  const emitRepairProgress = () => {
    if (!meta) return
    const repairBytes = verificationState.repairBytes(meta.size)
    const doneBytes = Math.max(0, meta.size - repairBytes)
    callbacks.onProgress({ doneBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
    if (dataChannel.current) sendData(dataChannel.current, { type: "progress", doneBytes, revision: meta.revision })
  }

  const verifyOrRequestRepair = async (
    manifest: P2PVerificationManifest,
    indicesToVerify?: Iterable<number>,
    isCurrent: () => boolean = () => true,
  ) => {
    const mismatches = await verifyReceivedBlocks(manifest, indicesToVerify, isCurrent)
    if (!isCurrent()) return
    if (mismatches.length === 0) {
      if (dataChannel.current) sendData(dataChannel.current, { type: "verified" })
      await finishVerifiedTransfer("File received and verified. Saving should start automatically.", isCurrent)
      return
    }

    if (!verificationState.beginRepair(mismatches, maxVerificationRepairAttempts)) {
      const message = `Transfer verification failed after ${maxVerificationRepairAttempts} repair attempts.`
      await failVerifiedTransfer(message, isCurrent)
      if (!isCurrent()) return
      callbacks.onError(new Error(message))
      return
    }

    transitionTransfer({ kind: "repairing" })
    emitRepairProgress()
    callbacks.onStatus(`Repairing ${mismatches.length} block${mismatches.length === 1 ? "" : "s"}...`)
    if (dataChannel.current) sendData(dataChannel.current, { type: "repair-request", indices: mismatches })
  }

  const preserveOrDisposeReceivedStorage = async (discardCompleted = false) => {
    await storageCoordinator.preserveOrDispose(receivedBytes, isComplete(), clearReceivedData, discardCompleted)
  }

  interface FinishReceiverRuntimeOptions {
    transferState?: ReceiverTransferState
    progress?: P2PProgress
    pauseState?: "keep" | "clear" | "paused"
    preserveRetryToken?: boolean
  }

  const finishReceiverRuntime = ({
    transferState = { kind: "idle" },
    progress,
    pauseState = "clear",
    preserveRetryToken = false,
  }: FinishReceiverRuntimeOptions = {}) => {
    isClosed = true
    verificationState.clear()
    connectionRecovery.finish({ preserveRetryToken })
    transitionTransfer(transferState)
    callbacks.onProgress(progress)
    if (pauseState === "clear") {
      clearPauseState()
    } else if (pauseState === "paused") {
      callbacks.onPausePendingChange?.(false)
      callbacks.onPausedChange(true)
    }
    signalingTransport.close()
    resetPeerConnection()
    void wakeLock.stop()
  }

  const stopExpiredReceiverSignaling = () => {
    if (isClosed) return
    const completed = isComplete()
    finishReceiverRuntime({
      transferState: completed ? { kind: "complete" } : { kind: "idle" },
      progress: completed && meta ? { doneBytes: meta.size, totalBytes: meta.size, speedBytesPerSecond: 0 } : undefined,
    })
    callbacks.onStatus(
      completed
        ? "Transfer complete. The signaling reconnect window expired; the file remains available."
        : "The signaling reconnect window expired. Previously completed files remain available.",
    )
    if (completed) {
      releaseRoomLock()
    } else if (ownsRoomSession) {
      void preserveOrDisposeReceivedStorage().finally(releaseRoomLock)
    }
  }

  const close = () => {
    if (closeCleanupStarted) return
    closeCleanupStarted = true
    const preserveCurrent =
      storageCoordinator.kind === "persistent" &&
      storageCoordinator.checkpoint !== undefined &&
      receivedBytes > 0 &&
      !isComplete()
    sendReceiverSignal({ type: "receiver-leave", resumable: preserveCurrent })
    storageCoordinator.queueDeletion(preserveCurrent)
    finishReceiverRuntime({ pauseState: "keep", preserveRetryToken: connectionRecovery.retryToken !== undefined })
    if (ownsRoomSession) void preserveOrDisposeReceivedStorage(true).finally(releaseRoomLock)
  }

  const stopUnavailableRoom = async () => {
    if (isClosed) return
    await storageCoordinator.enqueue(() => checkpointReceivedData(true)).catch(() => undefined)
    downloadRequestedChannel = undefined
    finishReceiverRuntime({
      transferState: { kind: "paused" },
      progress: meta ? { doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 } : undefined,
      pauseState: "paused",
    })
    callbacks.onStatus(
      storageCoordinator.checkpoint
        ? "P2P room is no longer available. The saved partial transfer has been retained."
        : "P2P room is no longer available. Transfer recovery has stopped.",
    )
    if (ownsRoomSession) await preserveOrDisposeReceivedStorage().finally(releaseRoomLock)
  }

  const probeRoomBeforeRetry = createP2PRoomRetryProbe(config, name, {
    shouldRun: () => !isClosed,
    onUnavailable: stopUnavailableRoom,
    onRetry: () => signalingTransport.restartReconnect(),
  })

  const requestDownloadFromCurrentOffset = async () => {
    const channel = dataChannel.current
    if (channel?.readyState !== "open" || isComplete() || isDiscarding() || !meta) return
    if (downloadRequestedChannel === channel) return
    downloadRequestedChannel = channel
    void wakeLock.start()
    if (meta.verifyTransfer) await ensureXXHashReady()
    await prepareReceivedStorage()
    if (
      channel !== dataChannel.current ||
      channel.readyState !== "open" ||
      downloadRequestedChannel !== channel ||
      isClosed
    )
      return
    if (receivedBytes === 0 && meta?.verifyTransfer) {
      verificationState.startHash()
    }
    lastProgressAt = performance.now()
    speedTracker = createSpeedTracker(receivedBytes)
    clearPauseState()
    callbacks.onProgress(meta ? { doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 } : undefined)
    sendData(channel, { type: "progress", doneBytes: receivedBytes, revision: meta.revision })
    sendData(channel, { type: "download", offset: receivedBytes, revision: meta.revision })
  }

  const requestDownload = () => {
    if (isClosed) return
    transitionTransfer({ kind: "downloading" })
    if (dataChannel.current?.readyState !== "open") {
      callbacks.onStatus("Reconnecting to start transfer...")
      connectionRecovery.request(true)
      return
    }
    void requestDownloadFromCurrentOffset().catch((error: unknown) => {
      transitionTransfer({ kind: "idle" })
      downloadRequestedChannel = undefined
      void wakeLock.stop()
      callbacks.onError(asError(error))
    })
  }

  const adoptPendingUpdate = async (resetCurrentData = true) => {
    const nextMeta = pendingUpdateMeta
    if (!nextMeta) return false
    // Completed OPFS-backed files must remain on disk while their transfer-history
    // cards can still preview or download them. Session close performs the cleanup.
    if (isComplete()) storageCoordinator.archiveCurrent()
    if (resetCurrentData) await resetReceivedData()
    meta = nextMeta
    pendingUpdateMeta = undefined
    transitionTransfer({ kind: "idle" })
    downloadRequestedChannel = undefined
    speedTracker = createSpeedTracker(0)
    callbacks.onUpdateAvailable?.(undefined)
    callbacks.onMeta(nextMeta)
    callbacks.onProgress(undefined)
    clearPauseState()
    return true
  }

  const finishStoppedTransfer = async (
    shouldRestart: boolean,
    isCurrent: () => boolean,
    options: { autoRestart?: boolean; terminatedStatus?: string } = {},
  ) => {
    transitionTransfer({ kind: "idle" })
    downloadRequestedChannel = undefined
    const cleanup = beginStoppedTransferCleanup()
    await cleanup
    if (stoppedTransferCleanup === cleanup) stoppedTransferCleanup = undefined
    if (!isCurrent()) return
    speedTracker = createSpeedTracker(0)
    callbacks.onProgress(undefined)
    clearPauseState()
    if (shouldRestart) {
      const adopted = await adoptPendingUpdate(false)
      if (!isCurrent() || !adopted) return
      if (options.autoRestart === false) {
        callbacks.onStatus("Updated file selected. Receive the file to reconnect and start.")
        void wakeLock.stop()
        return
      }
      callbacks.onStatus("Updated file selected. Starting to receive...")
      requestDownload()
      return
    }
    callbacks.onStatus(
      options.terminatedStatus ??
        (forceMemoryStorage
          ? "Disk storage failed. Receive the file again to retry in memory."
          : "Transfer terminated. Receive the file again to start over."),
    )
    void wakeLock.stop()
  }

  const acceptUpdate = () => {
    if (isClosed || !pendingUpdateMeta) return
    const channel = dataChannel.current
    const hasActiveTransfer = !isComplete() && (wantsDownload() || isPaused() || isPausePending() || receivedBytes > 0)
    if (channel?.readyState === "open" && hasActiveTransfer) {
      transitionTransfer({ kind: "stopping", restartAfterStop: true })
      downloadRequestedChannel = undefined
      clearPauseState()
      callbacks.onStatus("Switching to the updated file...")
      sendData(channel, { type: "stop" })
      void beginStoppedTransferCleanup().catch(callbacks.onError)
      return
    }

    void adoptPendingUpdate()
      .then((adopted) => {
        if (!adopted || isClosed) return
        callbacks.onStatus("Updated file selected. Starting to receive...")
        requestDownload()
      })
      .catch(callbacks.onError)
  }

  const pause = () => {
    if (isClosed) return
    const channel = dataChannel.current
    if (isComplete() || isPaused() || isPausePending() || !wantsDownload()) return
    transitionTransfer({ kind: "pausing" })
    downloadRequestedChannel = undefined
    callbacks.onPausePendingChange?.(true)
    callbacks.onStatus("Pausing...")
    if (meta) callbacks.onProgress({ doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
    if (isPeerTransportUsable() && channel) {
      sendData(channel, { type: "pause" })
      return
    }
    confirmPause()
    connectionRecovery.request(true)
  }

  const resume = () => {
    if (isClosed || isPausePending() || !isPaused()) return
    transitionTransfer({ kind: "downloading" })
    callbacks.onPausedChange(false)
    if (dataChannel.current?.readyState === "open") {
      callbacks.onStatus("Resuming transfer...")
      requestDownload()
      return
    }
    callbacks.onStatus("Reconnecting to resume transfer...")
    connectionRecovery.request(true)
  }

  const terminate = () => {
    if (isClosed) return
    const channel = dataChannel.current
    if (isComplete() || isDiscarding()) return
    downloadRequestedChannel = undefined
    transitionTransfer({ kind: "stopping", restartAfterStop: false })
    clearPauseState()
    callbacks.onProgress(meta ? { doneBytes: 0, totalBytes: meta.size, speedBytesPerSecond: 0 } : undefined)
    callbacks.onStatus("Terminating transfer...")
    void beginStoppedTransferCleanup().catch(callbacks.onError)
    if (isPeerTransportUsable() && channel) {
      sendData(channel, { type: "stop" })
      return
    }
    connectionRecovery.request(true)
  }

  function attachDataChannel(channel: RTCDataChannel) {
    downloadRequestedChannel = undefined
    const handleDataMessage = async (data: MessageEvent["data"], isCurrentChannel: () => boolean) => {
      if (typeof data === "string") {
        const message = parseP2PDataMessage(data, "sender")
        if (message.type === "meta") {
          if (isDiscarding()) {
            if (restartAfterStop() && pendingUpdateMeta) pendingUpdateMeta = message.meta
            return
          }
          if (message.meta.verifyTransfer) {
            if (message.meta.size > MAX_MEMORY_P2P_BYTES && forceMemoryStorage) {
              throw new Error("This file is too large to receive in memory after disk storage failed.")
            }
          }
          if (
            meta &&
            !p2pResumeMetaMatches(meta, message.meta) &&
            (receivedBytes > 0 || wantsDownload() || isPaused() || isComplete())
          ) {
            pendingUpdateMeta = message.meta
            callbacks.onUpdateAvailable?.(message.meta)
            downloadRequestedChannel = undefined
            if (wantsDownload()) await requestDownloadFromCurrentOffset()
            return
          }
          meta = message.meta
          callbacks.onMeta(meta)
          if (isPaused()) {
            callbacks.onProgress({ doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
            sendData(channel, { type: "progress", doneBytes: receivedBytes, revision: meta.revision })
            sendData(channel, { type: "pause" })
            callbacks.onStatus("Paused.")
            return
          }
          callbacks.onStatus(
            wantsDownload() && receivedBytes > 0
              ? "File details received. Resuming transfer..."
              : "File details received. Ready to receive.",
          )
          if (wantsDownload()) await requestDownloadFromCurrentOffset()
        } else if (message.type === "file-update") {
          if (message.meta.revision && message.meta.revision === meta?.revision) return
          if (!isComplete() && receivedBytes === 0 && !wantsDownload() && !isPaused() && !isPausePending()) {
            meta = message.meta
            callbacks.onMeta(meta)
            callbacks.onProgress(undefined)
            callbacks.onStatus("The sender updated the file. Ready to receive the new version.")
            return
          }
          pendingUpdateMeta = message.meta
          callbacks.onUpdateAvailable?.(message.meta)
        } else if (message.type === "verification-start") {
          if (!meta?.verifyTransfer || isDiscarding()) {
            throw new Error("Unexpected P2P verification manifest header.")
          }
          verificationState.startManifest(meta.size, message.blockSize, message.hashCount)
        } else if (message.type === "verification-chunk") {
          verificationState.appendManifest(message.startIndex, message.hashes)
        } else if (message.type === "done") {
          if (!meta) return
          if (isDiscarding()) return
          if (receivedBytes < meta.size) {
            verificationState.clearManifestAssembly()
            const retry = verificationState.nextIncompleteRetry(maxIncompleteTransferRetries)
            if (retry === undefined) {
              const errorMessage = `P2P transfer remained incomplete after ${maxIncompleteTransferRetries} retries.`
              await failVerifiedTransfer(errorMessage, isCurrentChannel)
              if (isCurrentChannel()) callbacks.onError(new Error(errorMessage))
              return
            }
            downloadRequestedChannel = undefined
            callbacks.onStatus(
              `Transfer ended early at ${receivedBytes} of ${meta.size} bytes. Requesting the missing data ` +
                `(retry ${retry}/${maxIncompleteTransferRetries})...`,
            )
            callbacks.onProgress({ doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
            await requestDownloadFromCurrentOffset()
            return
          }
          if (meta.verifyTransfer) {
            const result = verificationState.finishManifest(message.verification, meta.size)
            if ("error" in result) {
              callbacks.onError(new Error(result.error))
              return
            }
            const manifest = result.manifest
            transitionTransfer({ kind: "verifying" })
            callbacks.onStatus("Verifying transfer...")
            await verifyOrRequestRepair(manifest, undefined, isCurrentChannel)
            return
          }
          await finishVerifiedTransfer("Transfer complete.", isCurrentChannel)
        } else if (message.type === "error") {
          callbacks.onError(new Error(message.message))
        } else if (message.type === "paused") {
          confirmPause()
        } else if (message.type === "stopped") {
          const shouldRestart = restartAfterStop()
          await finishStoppedTransfer(shouldRestart, isCurrentChannel)
        } else if (message.type === "repair-start") {
          if (!verificationState.manifest || message.index >= verificationState.manifest.hashes.length) {
            throw new Error("Invalid P2P repair block index.")
          }
          const expectedSize = verificationBlockByteLength(message.index, meta?.size ?? 0)
          if (message.size !== expectedSize) throw new Error("P2P repair block size mismatch.")
          verificationState.startRepairBlock(message.index, message.size)
          callbacks.onStatus(`Repairing block ${message.index + 1}...`)
        } else if (message.type === "repair-end") {
          try {
            const completedRepair = verificationState.finishRepairBlock(message.index)
            if (completedRepair) {
              await replaceReceivedBlock(message.index, completedRepair.parts)
              if (!isCurrentChannel()) return
              const indicesToVerify = verificationState.completeRepair(message.index, completedRepair.repairedHash)
              emitRepairProgress()
              if (indicesToVerify && verificationState.manifest) {
                callbacks.onStatus("Verifying repaired blocks...")
                transitionTransfer({ kind: "verifying" })
                await verifyOrRequestRepair(verificationState.manifest, indicesToVerify, isCurrentChannel)
              }
            }
          } catch (error) {
            callbacks.onError(asError(error))
          }
        }
        return
      }

      if (!meta) return
      const isExpectedFileData = wantsDownload() || isPausePending()
      const isExpectedRepairData = transfer.isRepairing() && verificationState.hasRepairBlock
      if (isDiscarding()) return
      if (!isExpectedFileData && !isExpectedRepairData) {
        throw new Error("Unexpected P2P binary data for the current transfer state.")
      }
      const chunk = data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer)
      if (!(chunk instanceof ArrayBuffer)) throw new Error("Invalid P2P binary data.")
      if (!isCurrentChannel()) return
      if (verificationState.hasRepairBlock) {
        await verificationState.appendRepairChunk(chunk)
        return
      }
      if (receivedBytes > meta.size || chunk.byteLength > meta.size - receivedBytes) {
        throw new Error("P2P transfer exceeds the declared file size.")
      }
      await appendReceivedBlockData(chunk)
      if (!isCurrentChannel()) return
      const now = performance.now()
      if (meta && (now - lastProgressAt >= progressUpdateIntervalMs || receivedBytes >= meta.size)) {
        lastProgressAt = now
        if (dataChannel.current) {
          sendData(dataChannel.current, { type: "progress", doneBytes: receivedBytes, revision: meta.revision })
        }
        callbacks.onProgress({
          doneBytes: receivedBytes,
          totalBytes: meta.size,
          speedBytesPerSecond: measureSpeed(speedTracker, receivedBytes),
        })
      }
    }

    dataChannel.attach(channel, {
      isClosed: () => isClosed,
      onOpen: (activeChannel) => {
        if (pc) refreshConnectionRoute(pc)
        connectionRecovery.finish()
        if (isDiscarding()) {
          callbacks.onStatus(
            restartAfterStop() ? "Reconnected. Finishing file switch..." : "Reconnected. Finishing termination...",
          )
          sendData(activeChannel, { type: "stop" })
          return
        }
        callbacks.onStatus(
          isPaused()
            ? "Paused. Waiting for file details..."
            : wantsDownload() && receivedBytes > 0
              ? "Reconnected. Resuming transfer..."
              : "Connected. Waiting for file details...",
        )
        if (wantsDownload() && meta) void requestDownloadFromCurrentOffset().catch(callbacks.onError)
      },
      onMessage: (data, _activeChannel, isCurrentChannel) => handleDataMessage(data, isCurrentChannel),
      onMessageError: async (receivedError, activeChannel) => {
        if (
          (storageCoordinator.kind === "opfs" || storageCoordinator.kind === "persistent") &&
          (meta?.size ?? 0) <= MAX_MEMORY_P2P_BYTES
        ) {
          forceMemoryStorage = true
          transitionTransfer({ kind: "stopping", restartAfterStop: false })
          downloadRequestedChannel = undefined
          callbacks.onProgress(undefined)
          clearPauseState()
          callbacks.onStatus("Disk storage failed. Stopping transfer...")
          sendData(activeChannel, { type: "stop" })
          await beginStoppedTransferCleanup()
          callbacks.onError(new Error(`Unable to write the P2P temporary file: ${receivedError.message}`))
          return
        }
        if (storageCoordinator.kind === "opfs" || storageCoordinator.kind === "persistent") {
          transitionTransfer({ kind: "stopping", restartAfterStop: false })
          downloadRequestedChannel = undefined
          callbacks.onProgress(undefined)
          clearPauseState()
          callbacks.onStatus("Disk storage failed and the file is too large for memory fallback.")
          sendData(activeChannel, { type: "stop" })
          await beginStoppedTransferCleanup()
          callbacks.onError(new Error(`Unable to write the P2P temporary file: ${receivedError.message}`))
          return
        }
        callbacks.onError(receivedError)
      },
      onDisconnect: () => {
        if (!isComplete()) connectionRecovery.request(true)
      },
    })
  }

  function ensurePeerConnection(iceMode: P2PIceMode = "all"): RTCPeerConnection | undefined {
    if (isClosed) return undefined
    if (pc) return pc
    const connection = new RTCPeerConnection(rtcConfig(iceServers, { mode: iceMode }))
    pc = connection
    const refreshCurrentConnectionRoute = () => refreshConnectionRoute(connection)
    connection.onicecandidate = (event) => {
      if (!isClosed && pc === connection && event.candidate) {
        sendReceiverSignal({ type: "candidate", peerId, candidate: event.candidate.toJSON(), negotiationId })
      }
    }
    connection.oniceconnectionstatechange = () => {
      if (
        !isClosed &&
        pc === connection &&
        (connection.iceConnectionState === "connected" || connection.iceConnectionState === "completed")
      ) {
        refreshCurrentConnectionRoute()
      }
    }
    connection.onconnectionstatechange = () => {
      if (isClosed || pc !== connection) return
      if (connection.connectionState === "connected") {
        refreshCurrentConnectionRoute()
        connectionRecovery.finish()
        callbacks.onStatus(isPaused() ? "Paused." : "Peer connected.")
      }
      if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
        connectionRecovery.request(connection.connectionState === "failed")
      }
    }
    connection.ondatachannel = (event) => {
      if (isClosed || pc !== connection) {
        event.channel.close()
        return
      }
      attachDataChannel(event.channel)
    }
    return connection
  }

  function refreshConnectionRoute(connection: RTCPeerConnection): void {
    refreshP2PConnectionRoute(
      connection,
      (route) => {
        if (isClosed || pc !== connection || route === connectionRoute) return
        connectionRoute = route
        callbacks.onConnectionRouteChange?.(route)
      },
      () => !isClosed && pc === connection,
    )
  }

  function resetPeerConnection(options: { preserveConnectionRoute?: boolean } = {}) {
    if (isPausePending()) confirmPause()
    connectionRecovery.defer()
    downloadRequestedChannel = undefined
    const channel = dataChannel.detach()
    const connection = pc
    pc = undefined
    if (!isComplete() && !options.preserveConnectionRoute && connectionRoute !== undefined) {
      connectionRoute = undefined
      callbacks.onConnectionRouteChange?.(undefined)
    }
    closeP2PConnection(connection, channel)
    iceCandidates.clear()
    negotiationId = undefined
  }

  const restoreSavedTransfer = async () => {
    const checkpoint = storageCoordinator.checkpoint
    if (!checkpoint) return
    if (!storageCoordinator.canRestore()) {
      storageCoordinator.clearCheckpoint()
      return
    }

    callbacks.onStatus("Restoring saved transfer...")
    try {
      const completedHashBytes = checkpoint.meta.verifyTransfer
        ? checkpoint.completedHashes.length * verificationBlockSize
        : checkpoint.receivedBytes
      const restoredTail = await storageCoordinator.restore(checkpoint.receivedBytes, completedHashBytes)
      meta = checkpoint.meta
      receivedBytes = checkpoint.receivedBytes
      transitionTransfer({ kind: "paused" })
      if (meta.verifyTransfer) {
        await ensureXXHashReady()
        verificationState.startHash(checkpoint.completedHashes.slice())
        await verificationState.appendFileChunk(restoredTail)
      }
      speedTracker = createSpeedTracker(receivedBytes)
      callbacks.onMeta(meta)
      callbacks.onProgress({ doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
      callbacks.onPausePendingChange?.(false)
      callbacks.onPausedChange(true)
      callbacks.onStatus("Saved transfer restored and paused. Looking for the sender...")
    } catch {
      storageCoordinator.clearCheckpoint()
      storageCoordinator.rotateId()
      meta = undefined
      clearReceivedData()
      callbacks.onStatus("Saved transfer was unavailable. Restarting from the beginning...")
    }
  }

  const signalingTransport: P2PSignalingTransport = createP2PSignalingTransport({
    url: () => wsUrl(config, name, "receiver", { peerId }),
    reconnectWindowMs: () =>
      hasCompletedTransfer ? P2P_SIGNAL_RECONNECT_GRACE_MS : P2P_RECEIVER_SIGNAL_RECONNECT_WINDOW_MS,
    shouldReconnect: () => !isClosed && !senderLeft,
    onOpen: (isReconnect) => {
      storageCoordinator.onSignalingOpen()
      callbacks.onStatus(
        isPeerTransportUsable()
          ? isPaused()
            ? "Paused. Signaling connected; synchronizing..."
            : "Signaling connected; synchronizing while transfer continues..."
          : isPaused()
            ? isReconnect
              ? "Paused. Signaling reconnected..."
              : "Paused. Looking for the sender..."
            : isReconnect
              ? receivedBytes > 0
                ? "Signaling reconnected. Waiting to resume transfer..."
                : "Signaling reconnected. Looking for the sender..."
              : "Looking for the sender...",
      )
    },
    onSocketError: () => {
      isSignalingReady = false
      callbacks.onStatus(
        isPeerTransportUsable()
          ? "P2P signaling connection failed. Existing transfer continues while reconnecting..."
          : "P2P signaling connection failed. Reconnecting...",
      )
    },
    onClose: () => {
      isSignalingReady = false
      senderSignalingAvailable = false
      connectionRecovery.defer()
      if (senderLeft) {
        connectionRecovery.finish()
        callbacks.onStatus("Sender left.")
        return
      }
      if (!isPeerTransportUsable() && (wantsDownload() || isPaused() || receivedBytes > 0)) {
        connectionRecovery.begin()
      }
      callbacks.onStatus(
        isPeerTransportUsable()
          ? isPaused()
            ? "Paused. Signaling disconnected; peer connection remains available."
            : "P2P signaling disconnected. Transfer continues."
          : isPaused()
            ? "Paused. Reconnecting to the sender..."
            : wantsDownload() || receivedBytes > 0
              ? "Connection lost. Reconnecting to resume transfer..."
              : "P2P signaling closed. Reconnecting...",
      )
    },
    onReconnectExhausted: () => {
      if (hasCompletedTransfer) {
        stopExpiredReceiverSignaling()
        return
      }
      if (
        isPeerTransportUsable() ||
        connectionRecovery.active ||
        storageCoordinator.checkpoint !== undefined ||
        receivedBytes > 0 ||
        isPaused() ||
        wantsDownload()
      ) {
        callbacks.onStatus(
          isPeerTransportUsable()
            ? "Signaling is still unavailable. Transfer continues while retrying..."
            : "Signaling is still unavailable. Retrying to preserve transfer recovery...",
        )
        probeRoomBeforeRetry()
        return
      }
      finishReceiverRuntime()
      void preserveOrDisposeReceivedStorage().finally(releaseRoomLock)
      callbacks.onStatus("Unable to reconnect to the sender. Transfer session closed.")
    },
    onImmediateMessage: (message) => {
      if (message.type === "receiver-reconnect-expired") {
        stopExpiredReceiverSignaling()
        return true
      }
      if (message.type === "transfer-limit-complete") {
        callbacks.onTransferLimitReached?.()
        return true
      }
      if (message.type === "room-options-updated") {
        callbacks.onRoomAvailabilityChange?.(message.joinable)
        return true
      }
      if (message.type === "transfer-checkpoint-result") {
        storageCoordinator.onRegistrationResult(message.accepted)
        return true
      }
      return false
    },
    onMessage: async (message, isCurrentSocket) => {
      if (message.type === "ready") {
        isSignalingReady = true
        senderSignalingAvailable = message.peers.sender
        signalingTransport.resetReconnect()
        if ("iceServers" in message) iceServers = message.iceServers
        storageCoordinator.onSignalingReady()
        if (connectionRecovery.active && !isPeerTransportUsable() && senderSignalingAvailable) {
          connectionRecovery.retryNow()
        } else if (connectionRecovery.retryToken && !isPeerTransportUsable() && senderSignalingAvailable) {
          connectionRecovery.begin()
          connectionRecovery.retryNow()
        }
        if (isPeerTransportUsable()) {
          callbacks.onStatus(
            isComplete()
              ? "Transfer complete. Signaling restored."
              : isPaused()
                ? "Paused. Signaling restored."
                : "Signaling restored. Transfer continues.",
          )
        } else if (message.peers.sender) {
          callbacks.onStatus(
            isPaused()
              ? "Paused. Waiting for WebRTC pairing..."
              : wantsDownload() || receivedBytes > 0
                ? "Reconnected. Waiting for WebRTC pairing..."
                : "Sender found. Pairing...",
          )
        }
      }
      if (message.type === "offer") {
        isSignalingReady = true
        senderSignalingAvailable = true
        if (connectionRecovery.active) connectionRecovery.defer()
        resetPeerConnection({ preserveConnectionRoute: true })
        negotiationId = message.negotiationId
        if (!isCurrentSocket()) return
        const connection = ensurePeerConnection(message.directOnly === true ? "direct" : "all")
        if (!connection) return
        await connection.setRemoteDescription(message.sdp)
        if (!isCurrentSocket() || pc !== connection) return
        await iceCandidates.flush(connection, () => isCurrentSocket() && pc === connection)
        if (!isCurrentSocket() || pc !== connection) return
        const answer = await connection.createAnswer()
        if (!isCurrentSocket() || pc !== connection) return
        await connection.setLocalDescription(answer)
        if (!isCurrentSocket() || pc !== connection) return
        signalingTransport.send({ type: "answer", peerId, sdp: answer, negotiationId })
      }
      if (message.type === "peer-signaling-disconnected" && message.role === "sender") {
        senderSignalingAvailable = false
        connectionRecovery.defer()
        callbacks.onStatus(
          isPeerTransportUsable()
            ? isPaused()
              ? "Paused. Sender signaling disconnected; peer connection remains available."
              : "Sender signaling disconnected. Transfer continues."
            : isPaused()
              ? "Paused. Waiting for sender signaling to reconnect..."
              : "Peer connection interrupted. Waiting for sender signaling to reconnect...",
        )
      }
      if (message.type === "candidate") {
        if (message.negotiationId && negotiationId && message.negotiationId !== negotiationId) return
        const connection = pc
        if (connection) {
          await iceCandidates.addOrBuffer(connection, message.candidate, () => isCurrentSocket() && pc === connection)
        } else {
          iceCandidates.add(message.candidate)
        }
      }
      if (message.type === "receiver-pair-result" && message.accepted && storageCoordinator.checkpoint) {
        storageCoordinator.registerCheckpoint()
      }
      if (message.type === "peer-reconnect-failed") {
        connectionRecovery.finish()
        connectionRecovery.setRetryToken(message.retryToken)
        if (isDiscarding()) {
          const shouldRestart = restartAfterStop()
          resetPeerConnection({ preserveConnectionRoute: true })
          await finishStoppedTransfer(shouldRestart, () => !isClosed, {
            autoRestart: false,
            terminatedStatus: "Transfer terminated. Receive the file again to reconnect and start over.",
          })
          return
        }
        if (!isComplete() && !isDiscarding()) {
          resetPeerConnection({ preserveConnectionRoute: true })
          transitionTransfer({ kind: "paused" })
          downloadRequestedChannel = undefined
          callbacks.onPausePendingChange?.(false)
          callbacks.onPausedChange(true)
          if (meta) {
            callbacks.onProgress({ doneBytes: receivedBytes, totalBytes: meta.size, speedBytesPerSecond: 0 })
          }
          void storageCoordinator.enqueue(() => checkpointReceivedData(true)).catch(callbacks.onError)
          void wakeLock.stop()
          callbacks.onStatus("Connection recovery failed. Resume to retry.")
        }
      }
      if (message.type === "receiver-limit-reached") {
        rotatePeerIdForNextSession()
        finishReceiverRuntime()
        callbacks.onStatus("P2P transfer limit reached.")
        void resetReceivedData().finally(releaseRoomLock)
        return
      }
      if (message.type === "transfer-abandoned") {
        rotatePeerIdForNextSession()
        finishReceiverRuntime()
        await resetReceivedData()
        releaseRoomLock()
        callbacks.onStatus("Transfer abandoned. Starting a new session...")
        callbacks.onAbandoned?.()
        return
      }
      if (message.type === "peer-left" && message.role === "sender") {
        const completed = isComplete()
        rotatePeerIdForNextSession()
        senderLeft = true
        finishReceiverRuntime()
        if (completed) {
          releaseRoomLock()
          callbacks.onStatus("Sender left. The completed file remains available.")
          return
        }
        downloadRequestedChannel = undefined
        pendingUpdateMeta = undefined
        callbacks.onUpdateAvailable?.(undefined)
        callbacks.onProgress(undefined)
        await resetReceivedData()
        releaseRoomLock()
        callbacks.onStatus("Sender left. Transfer session closed.")
      }
    },
    onError: callbacks.onError,
  })

  const connectAfterRestore = () => {
    if (!storageCoordinator.checkpoint) {
      signalingTransport.connect()
      return
    }
    void restoreSavedTransfer()
      .then(() => {
        if (!isClosed) signalingTransport.connect()
      })
      .catch(callbacks.onError)
  }

  const lockRequest = acquireP2PReceiverRoomLock(name)
  if (lockRequest) {
    void lockRequest.then((lock) => {
      if (!lock) {
        isClosed = true
        callbacks.onStatus("This P2P room is already open in another tab.")
        return
      }
      if (isClosed) {
        lock.release()
        return
      }
      roomLock = lock
      ownsRoomSession = true
      connectAfterRestore()
    })
  } else {
    ownsRoomSession = true
    connectAfterRestore()
  }

  return { requestDownload, acceptUpdate, pause, resume, terminate, close }
}
