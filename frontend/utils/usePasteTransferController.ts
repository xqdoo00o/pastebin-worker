import { useCallback, useEffect, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react"

import type { PasteResponse, PublicEnv } from "../../shared/interfaces.js"
import { inferHighlightLanguage } from "../../shared/fileType.js"
import type { PasteEditState } from "../models/paste.js"
import { MAX_TRANSFER_BYTES } from "../optical/shared/protocol.js"
import { saveOpticalSenderSettings } from "../optical/shared/settings.js"
import {
  createUpdateSnapshot,
  hasUpdateChanged,
  p2pUpdateFields,
  prepareContent,
  type UpdateSnapshot,
  uploadUpdateFields,
} from "./content.js"
import type { LocalUploadRecord } from "./localUploads.js"
import { useP2PSenderController } from "./p2p/useSenderController.js"
import { pasteKeyFromUrl } from "./pasteUrls.js"
import {
  managedLinkType,
  normalizeLinkType,
  validatePasteSetting,
  type PasteSetting,
  type TransferMethod,
} from "./pasteSetting.js"
import type { UploadProgress } from "./uploader.js"
import { uploadPaste } from "./uploader.js"
import { useLocalUploads } from "./useLocalUploads.js"
import { verifyManageUrl, verifySizeLimit } from "./utils.js"
import { isAbortError } from "./errors.js"

interface PasteTransferControllerOptions {
  config: PublicEnv
  editorState: PasteEditState
  pasteSetting: PasteSetting
  settingsByMethodRef: { current: Partial<Record<TransferMethod, PasteSetting>> }
  setPasteSetting: Dispatch<SetStateAction<PasteSetting>>
  showModal: (title: string, content: string) => void
  handleError: (title: string, cause: unknown) => void
  handleFailedResponse: (title: string, response: Response) => Promise<void>
}

interface OpticalSenderState {
  file?: File
  highlightLanguage?: string
  lastUpdate: UpdateSnapshot | null
}

function useOpticalSenderController() {
  const [state, setState] = useState<OpticalSenderState>({
    file: undefined,
    highlightLanguage: undefined,
    lastUpdate: null,
  })
  const cleanupRef = useRef<(() => Promise<void>) | undefined>(undefined)

  const releaseCurrent = useCallback(() => {
    const cleanup = cleanupRef.current
    cleanupRef.current = undefined
    if (cleanup) void cleanup().catch(() => undefined)
  }, [])

  const close = useCallback(() => {
    releaseCurrent()
    setState({ file: undefined, highlightLanguage: undefined, lastUpdate: null })
  }, [releaseCurrent])

  const attach = useCallback(
    (file: File, editorState: PasteEditState, cleanup?: () => Promise<void>) => {
      releaseCurrent()
      cleanupRef.current = cleanup
      setState({
        file,
        highlightLanguage:
          editorState.editKind === "edit" ? editorState.editHighlightLang : inferHighlightLanguage(file.name),
        lastUpdate: createUpdateSnapshot(editorState, {}),
      })
    },
    [releaseCurrent],
  )

  return {
    ...state,
    attach,
    close,
    dispose: releaseCurrent,
  }
}

function pasteKeyFromMaybeUrl(url: string): string | undefined {
  try {
    return pasteKeyFromUrl(url)
  } catch {
    return undefined
  }
}

function hasEditorContent(editorState: PasteEditState): boolean {
  return editorState.editKind === "edit" ? editorState.editContent.length > 0 : editorState.files.length > 0
}

export function usePasteTransferController({
  config,
  editorState,
  pasteSetting,
  settingsByMethodRef,
  setPasteSetting,
  showModal,
  handleError,
  handleFailedResponse,
}: PasteTransferControllerOptions) {
  const [pasteResponse, setPasteResponse] = useState<PasteResponse | undefined>()
  const [uploadedEncryptionKey, setUploadedEncryptionKey] = useState<string | undefined>()
  const [lastPasteUpdate, setLastPasteUpdate] = useState<UpdateSnapshot | null>(null)
  const [loadingProgress, setLoadingProgress] = useState<UploadProgress | undefined>()
  const [latestLocalUploadKey, setLatestLocalUploadKey] = useState<string | undefined>()
  const [isUploadPending, startUpload] = useTransition()
  const [isDeletePending, startDelete] = useTransition()
  const uploadAbortRef = useRef<AbortController | null>(null)
  const transferMethodRef = useRef(pasteSetting.transferMethod)
  transferMethodRef.current = pasteSetting.transferMethod

  const { localUploads, externalRemoval, rememberLocalUpload, removeLocalUploadByKey } = useLocalUploads()
  const handleP2PError = useCallback((error: Error) => handleError("Error on P2P Transfer", error), [handleError])
  const p2p = useP2PSenderController(handleP2PError)
  const optical = useOpticalSenderController()
  const { dispose: disposeP2P } = p2p
  const { dispose: disposeOptical } = optical

  const isUploadMode = pasteSetting.transferMethod === "upload"
  const isP2PMode = pasteSetting.transferMethod === "p2p"
  const isOpticalMode = pasteSetting.transferMethod === "optical"

  const resetManagedUploadSetting = useCallback(
    (setting: PasteSetting): PasteSetting => ({
      ...setting,
      uploadKind: normalizeLinkType(config.DEFAULT_LINK_TYPE),
      manageUrl: "",
    }),
    [config.DEFAULT_LINK_TYPE],
  )

  useEffect(() => {
    saveOpticalSenderSettings(pasteSetting.optical)
  }, [pasteSetting.optical])

  useEffect(() => {
    const closePageResources = () => {
      const uploadController = uploadAbortRef.current
      uploadAbortRef.current = null
      uploadController?.abort()
      disposeP2P()
      disposeOptical()
    }
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) closePageResources()
    }

    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pagehide", handlePageHide)
      closePageResources()
    }
  }, [disposeOptical, disposeP2P])

  useEffect(() => {
    const uploadController = uploadAbortRef.current
    uploadAbortRef.current = null
    uploadController?.abort()
  }, [pasteSetting.transferMethod])

  const clearCurrentManagedPasteByKey = useCallback(
    (key: string): void => {
      const savedUploadSetting = settingsByMethodRef.current.upload
      if (!savedUploadSetting || pasteKeyFromMaybeUrl(savedUploadSetting.manageUrl) !== key) return

      setPasteResponse(undefined)
      setLastPasteUpdate(null)
      const clearedUploadSetting = resetManagedUploadSetting(savedUploadSetting)
      settingsByMethodRef.current.upload = clearedUploadSetting
      if (pasteSetting.transferMethod === "upload") setPasteSetting(clearedUploadSetting)
    },
    [pasteSetting.transferMethod, resetManagedUploadSetting, setPasteSetting, settingsByMethodRef],
  )

  function removeLocalUploadFromState(key: string): void {
    removeLocalUploadByKey(key)
    clearCurrentManagedPasteByKey(key)
  }

  useEffect(() => {
    if (externalRemoval.revision === 0) return
    for (const key of externalRemoval.keys) clearCurrentManagedPasteByKey(key)
  }, [clearCurrentManagedPasteByKey, externalRemoval])

  function assertActiveTransferMethod(signal: AbortSignal, expected: PasteSetting["transferMethod"]): void {
    signal.throwIfAborted()
    if (transferMethodRef.current !== expected) throw new DOMException("Transfer mode changed.", "AbortError")
  }

  function validateOpticalSize(file: File): boolean {
    const [sizeOk, sizeMessage] = verifySizeLimit(file.size, MAX_TRANSFER_BYTES)
    if (sizeOk) return true
    const multipleFiles = editorState.editKind === "file" && editorState.files.length > 1
    showModal(multipleFiles ? "Pastes too large" : "Paste too large", sizeMessage)
    return false
  }

  async function prepareAndAttachOptical(signal: AbortSignal): Promise<void> {
    const prepared = await prepareContent(editorState, {
      errorTitle: "Error on Preparing QR Camera Share",
      archiveCompression: pasteSetting.archiveCompression,
      signal,
    })
    let attached = false
    try {
      assertActiveTransferMethod(signal, "optical")
      if (!validateOpticalSize(prepared.content)) return
      assertActiveTransferMethod(signal, "optical")
      optical.attach(prepared.content, editorState, prepared.cleanup)
      attached = true
    } finally {
      if (!attached) await prepared.cleanup?.()
    }
  }

  function runTransferTask(errorTitle: string, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    uploadAbortRef.current = controller
    startUpload(async () => {
      try {
        await task(controller.signal)
      } catch (error) {
        if (!isAbortError(error)) handleError(errorTitle, error)
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null
      }
    })
  }

  async function prepareAndAttachP2P(startingSetting: PasteSetting, signal: AbortSignal): Promise<void> {
    const prepared = await prepareContent(editorState, {
      errorTitle: "Error on Preparing P2P Share",
      archiveCompression: startingSetting.archiveCompression,
      compressSingleFile: startingSetting.compressSingleFile,
      signal,
    })
    let cleanupTransferred = false
    try {
      const { startP2PSender } = await import("./p2pSender.js")
      signal.throwIfAborted()
      const session = await startP2PSender({
        file: prepared.content,
        config,
        expire: startingSetting.expiration,
        maxTransfers: startingSetting.readLimit,
        verifyTransfer: startingSetting.verifyP2P,
        callbacks: p2p.callbacks,
        signal,
        highlightLanguage:
          editorState.editKind === "edit"
            ? editorState.editHighlightLang
            : inferHighlightLanguage(prepared.content.name),
        fileCleanup: prepared.cleanup,
        isPrivate: startingSetting.uploadKind === "long",
        originalFiles: prepared.originalFiles,
      })
      cleanupTransferred = true
      try {
        assertActiveTransferMethod(signal, "p2p")
        p2p.attach(session, createUpdateSnapshot(editorState, p2pUpdateFields(startingSetting)))
      } catch (error) {
        session.close()
        throw error
      }
    } finally {
      if (!cleanupTransferred) await prepared.cleanup?.()
    }
  }

  async function uploadNewPaste(startingSetting: PasteSetting, signal: AbortSignal): Promise<void> {
    let nextEncryptionKey: string | undefined
    const uploaded = await uploadPaste(
      startingSetting,
      editorState,
      (key) => {
        nextEncryptionKey = key
        setUploadedEncryptionKey(key)
      },
      config,
      setLoadingProgress,
      signal,
    )
    setPasteResponse(uploaded)
    rememberLocalUpload(uploaded, nextEncryptionKey)
    setLatestLocalUploadKey(pasteKeyFromUrl(uploaded.url))
    const nextSetting = { ...startingSetting, uploadKind: "manage" as const, manageUrl: uploaded.manageUrl }
    setPasteSetting(nextSetting)
    setLastPasteUpdate(createUpdateSnapshot(editorState, uploadUpdateFields(nextSetting)))
  }

  function startTransfer(startingSetting: PasteSetting): void {
    const startingUploadMode = startingSetting.transferMethod === "upload"
    const startingP2PMode = startingSetting.transferMethod === "p2p"
    const startingOpticalMode = startingSetting.transferMethod === "optical"

    setPasteResponse(undefined)
    setUploadedEncryptionKey(undefined)
    if (!startingUploadMode) {
      setLastPasteUpdate(null)
      const savedUploadSetting = settingsByMethodRef.current.upload
      if (savedUploadSetting?.uploadKind === "manage") {
        settingsByMethodRef.current.upload = resetManagedUploadSetting(savedUploadSetting)
      }
    }
    p2p.close()
    optical.close()
    const errorTitle = startingOpticalMode
      ? "Error on Starting QR Camera Share"
      : startingP2PMode
        ? "Error on Starting P2P Share"
        : "Error on Uploading Paste"
    runTransferTask(errorTitle, async (signal) => {
      signal.throwIfAborted()
      if (startingOpticalMode) return await prepareAndAttachOptical(signal)
      if (startingP2PMode) return await prepareAndAttachP2P(startingSetting, signal)
      await uploadNewPaste(startingSetting, signal)
    })
  }

  function start(): void {
    startTransfer(pasteSetting)
  }

  function startNewUpload(): void {
    const linkType = managedLinkType(pasteSetting.manageUrl)
    if (!isManageMode || !linkType) return
    startTransfer({ ...pasteSetting, uploadKind: linkType, manageUrl: "" })
  }

  function cancel(): void {
    uploadAbortRef.current?.abort()
    p2p.close()
    optical.close()
  }

  function updateOptical(): void {
    if (!optical.file || optical.lastUpdate === null || !hasUpdateChanged(optical.lastUpdate, editorState, {})) return
    runTransferTask("Error on Updating QR Camera Share", prepareAndAttachOptical)
  }

  function updateP2P(): void {
    const session = p2p.sessionRef.current
    const previousUpdate = p2p.lastUpdate
    if (!session || !previousUpdate || !hasUpdateChanged(previousUpdate, editorState, p2pUpdateFields(pasteSetting))) {
      return
    }
    runTransferTask("Error on Updating P2P Share", async (signal) => {
      let pendingContentCleanup: (() => Promise<void>) | undefined
      try {
        const fileVersionChanged = hasUpdateChanged(previousUpdate, editorState, {
          verifyP2P: pasteSetting.verifyP2P,
          archiveCompression: pasteSetting.archiveCompression,
          compressSingleFile: pasteSetting.compressSingleFile ?? false,
        })
        const prepared = fileVersionChanged
          ? await prepareContent(editorState, {
              errorTitle: "Error on Preparing P2P Share",
              archiveCompression: pasteSetting.archiveCompression,
              compressSingleFile: pasteSetting.compressSingleFile,
              signal,
            })
          : undefined
        pendingContentCleanup = prepared?.cleanup
        signal.throwIfAborted()
        if (!p2p.isCurrent(session)) return
        const updatedRoom = await session.updateRoomOptions(pasteSetting.expiration, pasteSetting.readLimit, signal)
        signal.throwIfAborted()
        if (!p2p.isCurrent(session)) return
        if (prepared) {
          p2p.setCurrentFile(
            session.updateFile(
              prepared.content,
              pasteSetting.verifyP2P,
              editorState.editKind === "edit"
                ? editorState.editHighlightLang
                : inferHighlightLanguage(prepared.content.name),
              prepared.cleanup,
              prepared.originalFiles,
            ),
          )
          pendingContentCleanup = undefined
        }
        p2p.updateRoom(updatedRoom.expireAt, updatedRoom.expirationSeconds)
        p2p.setLastUpdate(createUpdateSnapshot(editorState, p2pUpdateFields(pasteSetting)))
      } finally {
        await pendingContentCleanup?.()
      }
    })
  }

  function deleteManagedPaste(): void {
    startDelete(async () => {
      const manageUrl = pasteSetting.manageUrl
      if (await deletePaste(manageUrl, undefined, false)) {
        showModal("Deleted Successfully", "It may takes 60 seconds for the deletion to propagate to the world")
      }
    })
  }

  async function deletePaste(manageUrl: string, key: string | undefined, acceptMissing: boolean): Promise<boolean> {
    try {
      const response = await fetch(manageUrl, { method: "DELETE" })
      if (response.ok || (acceptMissing && (response.status === 404 || response.status === 410))) {
        removeLocalUploadFromState(key ?? pasteKeyFromUrl(manageUrl))
        return true
      }
      await handleFailedResponse("Error on Delete Paste", response)
      return false
    } catch (error) {
      handleError("Error on Delete Paste", error)
      return false
    }
  }

  function deleteLocalUpload(upload: LocalUploadRecord): Promise<boolean> {
    return deletePaste(upload.manageUrl, upload.key, true)
  }

  const isManageMode = isUploadMode && pasteSetting.uploadKind === "manage"
  const canStart =
    hasEditorContent(editorState) && (!isUploadMode || validatePasteSetting(pasteSetting, config).isValid)
  const canDelete = verifyManageUrl(pasteSetting.manageUrl, config)[0]
  const newUploadDisabled = !canStart || isUploadPending || isDeletePending
  const startDisabled =
    newUploadDisabled ||
    (isManageMode &&
      lastPasteUpdate !== null &&
      !hasUpdateChanged(lastPasteUpdate, editorState, uploadUpdateFields(pasteSetting)))
  const hasActiveP2PSession = isP2PMode && p2p.response !== undefined
  const hasActiveOpticalSession = isOpticalMode && optical.file !== undefined
  const hasP2PChanges =
    p2p.lastUpdate !== null && hasUpdateChanged(p2p.lastUpdate, editorState, p2pUpdateFields(pasteSetting))
  const hasOpticalChanges = optical.lastUpdate !== null && hasUpdateChanged(optical.lastUpdate, editorState, {})
  const updateDisabled =
    !canStart || isUploadPending || isDeletePending || !(hasActiveOpticalSession ? hasOpticalChanges : hasP2PChanges)

  return {
    pasteResponse,
    setPasteResponse,
    uploadedEncryptionKey,
    lastPasteUpdate,
    setLastPasteUpdate,
    loadingProgress,
    latestLocalUploadKey,
    localUploads,
    p2p,
    optical,
    isUploadPending,
    isDeletePending,
    isUploadMode,
    isP2PMode,
    isOpticalMode,
    isManageMode,
    hasP2PPanel: p2p.response !== undefined || (isP2PMode && isUploadPending),
    hasActiveP2PSession,
    hasActiveOpticalSession,
    hasUploadResultPanel: pasteResponse !== undefined || (isUploadMode && isUploadPending),
    startDisabled,
    newUploadDisabled,
    updateDisabled,
    deleteDisabled: !canDelete || isUploadPending || isDeletePending,
    start,
    startNewUpload,
    cancel,
    update: hasActiveOpticalSession ? updateOptical : updateP2P,
    deleteManagedPaste,
    deleteLocalUpload,
  }
}
