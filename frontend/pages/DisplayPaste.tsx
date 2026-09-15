import { useCallback, useEffect, useRef, useState } from "react"
import { useErrorModal } from "../components/ErrorModal.js"
import { DisplayPasteView } from "./DisplayPasteView.js"
import { parsePath } from "../../shared/parsers.js"
import type { PublicEnv } from "../../shared/interfaces.js"
import { parseReadLimit } from "../../shared/verify.js"
import { removeLocalUpload } from "../utils/localUploads.js"
import { useP2PReceiverController, type P2PReceivedFileContext } from "../utils/p2p/useReceiverController.js"
import { getInitialPasteState, usePasteLoader } from "../utils/usePasteLoader.js"
import { errorMessage } from "../utils/errors.js"
import { classifyReceivedBlob } from "../utils/filePreview.js"

import "../style.css"
import "../styles/received-preview.css"
import "../styles/highlight-theme.css"

export function DisplayPaste({ config }: { config: PublicEnv }) {
  const [url] = useState(() => new URL(location.toString()))
  const { role, name, ext, filename } = parsePath(url.pathname)
  const [initialPasteState] = useState(() => getInitialPasteState(url, name, ext, filename))

  const [forceShowBinary, setForceShowBinary] = useState(false)
  const [showExpiredNotice, setShowExpiredNotice] = useState(false)
  const expiredNoticeTimerRef = useRef<number | undefined>(undefined)

  const showExpiredNoticeAfterDelay = useCallback(() => {
    if (expiredNoticeTimerRef.current !== undefined) {
      window.clearTimeout(expiredNoticeTimerRef.current)
    }
    expiredNoticeTimerRef.current = window.setTimeout(() => {
      setShowExpiredNotice(true)
      expiredNoticeTimerRef.current = undefined
    }, 3000)
  }, [])

  const hideExpiredNotice = useCallback(() => {
    if (expiredNoticeTimerRef.current !== undefined) {
      window.clearTimeout(expiredNoticeTimerRef.current)
      expiredNoticeTimerRef.current = undefined
    }
    setShowExpiredNotice(false)
  }, [])

  const { errorModal, showModal, handleFailedResp } = useErrorModal()
  const removeLocalUploadIfConsumed = useCallback(
    (remainingReads: string | number | null | undefined) => {
      const parsed = parseReadLimit(remainingReads)
      if (parsed !== null && parsed <= 1) {
        removeLocalUpload(name)
        showExpiredNoticeAfterDelay()
      }
    },
    [name, showExpiredNoticeAfterDelay],
  )
  const paste = usePasteLoader({
    url,
    name,
    ext,
    filename,
    enabled: role !== "p",
    initialState: initialPasteState,
    onReadConsumed: removeLocalUploadIfConsumed,
    showError: showModal,
    handleFailedResponse: handleFailedResp,
  })
  const p2p = useP2PReceiverController(name, config, {
    onFile: handleP2PFile,
    onStartError: (error) => showModal("Error on Starting P2P Transfer", error.message),
    onError: (error) => showModal("Error on P2P Transfer", error.message),
    onTransferLimitReached: showExpiredNoticeAfterDelay,
    onRoomAvailable: hideExpiredNotice,
    onAcceptUpdate: () => {
      paste.clearPreview()
    },
  })
  const { dispose: disposeP2P, start: startP2P } = p2p
  const { dispose: disposePaste } = paste

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        disposeP2P()
        disposePaste()
      }
    }
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pagehide", handlePageHide)
      disposeP2P()
      disposePaste()
      if (expiredNoticeTimerRef.current !== undefined) {
        window.clearTimeout(expiredNoticeTimerRef.current)
      }
    }
  }, [disposeP2P, disposePaste])

  useEffect(() => {
    if (role === "p") void startP2P()
  }, [role, startP2P])

  async function handleP2PFile(file: File, context: P2PReceivedFileContext): Promise<void> {
    const { isCurrent, highlightLanguage, setCanPreview, setStatus } = context
    try {
      if (!isCurrent()) return
      const { preview, bytes, encoding } = await classifyReceivedBlob(file, config.DISALLOWED_MIME_FOR_PASTE ?? [], [
        "image",
      ])
      if (!isCurrent()) return

      if (preview.kind === "image") {
        setCanPreview(true)
        paste.showMediaPreview(file)
        setForceShowBinary(false)
        return
      }

      const canPreview = preview.kind === "text" || preview.kind === "deferred-text"
      setCanPreview(canPreview)
      if (canPreview) {
        if (bytes) await loadP2PTextPreview(file, bytes, isCurrent, highlightLanguage, encoding)
        else setStatus("Transfer complete. Choose whether to preview or save.")
        return
      }
      paste.downloadFile(file)
    } catch (error) {
      if (isCurrent()) {
        showModal("Error Preparing Received P2P File", errorMessage(error))
      }
    }
  }

  async function loadP2PTextAnyway(): Promise<void> {
    const file = p2p.file
    if (!file || !p2p.canPreviewFile) return
    const isCurrentFile = p2p.captureFileGuard()
    const highlightLanguage = p2p.meta?.highlightLanguage
    paste.setLoading(true)
    try {
      await loadP2PTextPreview(file, undefined, isCurrentFile, highlightLanguage)
    } finally {
      if (isCurrentFile()) paste.setLoading(false)
    }
  }

  async function loadP2PTextPreview(
    file: File,
    existingContent?: Uint8Array<ArrayBuffer>,
    isCurrentSession: () => boolean = () => true,
    highlightLanguage?: string,
    encoding: "UTF-8" | null = null,
  ): Promise<void> {
    const content = existingContent ?? new Uint8Array(await file.arrayBuffer())
    if (!isCurrentSession()) return
    paste.showPreview({
      file,
      content,
      lang: highlightLanguage,
      isBinary: false,
      encoding,
    })
    setForceShowBinary(false)
  }

  return (
    <>
      <DisplayPasteView
        forceShowBinary={forceShowBinary}
        name={name}
        ext={ext}
        filename={filename}
        config={config}
        showExpiredNotice={showExpiredNotice}
        showMissingEncryptionKeyNotice={
          role !== "p" && paste.isDecrypted === "encrypted" && url.hash.slice(1).length === 0
        }
        paste={{
          file: paste.pasteFile,
          contentBuffer: paste.pasteContentBuffer,
          lang: paste.pasteLang,
          isFileBinary: paste.isFileBinary,
          guessedEncoding: paste.guessedEncoding,
          isDecrypted: paste.isDecrypted,
          isLoading: paste.isLoading,
          isDownloading: paste.isDownloading,
          pendingInfo: paste.pendingInfo,
          mediaInfo: paste.mediaInfo,
          metaFilename: paste.metaFilename,
          originalFiles: paste.originalFiles,
        }}
        p2p={{
          isMode: p2p.isMode,
          status: p2p.status,
          connectionRoute: p2p.connectionRoute,
          meta: p2p.meta,
          updateMeta: p2p.updateMeta,
          transferHistory: p2p.transferHistory,
          progress: p2p.progress,
          file: p2p.file,
          isPaused: p2p.isPaused,
          isPausing: p2p.isPausing,
          isReconnecting: p2p.isReconnecting,
          isAcceptingUpdate: p2p.isAcceptingUpdate,
        }}
        actions={{
          setForceShowBinary,
          dismissExpiredNotice: () => setShowExpiredNotice(false),
          downloadP2P: p2p.requestDownload,
          pauseP2P: p2p.pause,
          resumeP2P: p2p.resume,
          terminateP2P: p2p.terminate,
          acceptP2PUpdate: p2p.acceptUpdate,
          loadP2PAnyway: p2p.file && p2p.canPreviewFile ? () => void loadP2PTextAnyway() : undefined,
          loadPasteAnyway: () => void paste.loadBody(),
          downloadPaste:
            paste.pendingInfo?.isReadLimited || (paste.isDecrypted === "encrypted" && url.hash.slice(1).length > 0)
              ? () => void paste.downloadBody()
              : undefined,
        }}
      />
      {errorModal}
    </>
  )
}
