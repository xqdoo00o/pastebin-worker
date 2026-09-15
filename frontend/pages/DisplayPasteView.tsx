import { useEffect, useMemo, useRef, useState } from "react"
import {
  ActionButton,
  CircularProgress,
  Link,
  PageContainer,
  PageShell,
  PageTopbar,
  Tooltip,
  actionControlClassName,
  iconControlClassName,
} from "../components/ui/index.js"
import { DarkModeToggle, useDarkModeSelection } from "../components/DarkModeToggle.js"
import { DownloadIcon, HomeIcon, RefreshIcon } from "../components/icons.js"
import { CopyWidget } from "../components/CopyWidget.js"
import { WebShareButton } from "../components/WebShareButton.js"
import { QrCodeTooltip } from "../components/QrCodeTooltip.js"
import { highlightHTML, useHljsForLang } from "../utils/highlight.js"
import { formatSize } from "../utils/utils.js"
import type { OriginalFileInfo, PublicEnv } from "../../shared/interfaces.js"
import type {
  P2PConnectionRoute,
  P2PFileMeta,
  P2PProgress,
  P2PTransferHistoryItem,
  P2PTransferStatus,
} from "../utils/p2p/protocol.js"
import { filenameForTitle, itemCountLabel } from "../../shared/format.js"
import { countTextLines } from "../components/LineNumbers.js"
import { mediaKindOfFile, mediaKindOfType, mediaPreviewBlob } from "../utils/filePreview.js"
import type { PasteMediaInfo, PastePendingInfo } from "../utils/usePasteLoader.js"
import {
  ActionRow,
  OriginalFileList,
  ReceiveCard,
  ReceiveNotice,
  ReceivedFilePlaceholder,
  ReceivedMediaPreview,
  ReceivedPreviewFrame,
  ReceivedTextContent,
  SaveFileLink,
} from "../components/ReceivedPreview.js"
import {
  P2PReceiveStatusCard,
  P2PReceiveStatusContent,
  P2PTransferHistoryCard,
} from "../components/P2PReceiveStatusCard.js"

function sizeSuffix(sizeBytes: number | null): string {
  return sizeBytes === null ? "" : ` (${formatSize(sizeBytes)})`
}

const zipSignatures = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
] as const

function isZipBuffer(buffer: Uint8Array | undefined): boolean {
  if (!buffer || buffer.length < 4) return false
  return zipSignatures.some((signature) => signature.every((byte, index) => buffer[index] === byte))
}

interface PasteDisplayState {
  file?: File
  contentBuffer?: Uint8Array
  lang?: string
  isFileBinary: boolean
  guessedEncoding: string | null
  isDecrypted: "not encrypted" | "encrypted" | "decrypted"
  isLoading: boolean
  isDownloading: boolean
  pendingInfo?: PastePendingInfo | null
  mediaInfo?: PasteMediaInfo | null
  metaFilename?: string
  originalFiles?: OriginalFileInfo[]
}

interface P2PDisplayState {
  isMode?: boolean
  status?: string
  connectionRoute?: P2PConnectionRoute
  meta?: P2PFileMeta
  updateMeta?: P2PFileMeta
  transferHistory?: P2PTransferHistoryItem[]
  progress?: P2PProgress
  file?: File
  isPaused?: boolean
  isPausing?: boolean
  isReconnecting?: boolean
  isAcceptingUpdate?: boolean
}

interface DisplayPasteActions {
  setForceShowBinary: (value: boolean) => void
  dismissExpiredNotice?: () => void
  downloadP2P?: () => void
  pauseP2P?: () => void
  resumeP2P?: () => void
  terminateP2P?: () => void
  acceptP2PUpdate?: () => void
  loadP2PAnyway?: () => void
  loadPasteAnyway?: () => void
  downloadPaste?: () => void
}

export interface DisplayPasteViewProps {
  name: string
  ext?: string
  filename?: string
  config: PublicEnv
  paste: PasteDisplayState
  p2p?: P2PDisplayState
  actions: DisplayPasteActions
  forceShowBinary: boolean
  showExpiredNotice?: boolean
  showMissingEncryptionKeyNotice?: boolean
}

interface ReceiveNoticesProps {
  showExpiredNotice: boolean
  isP2PMode: boolean
  onDismissExpiredNotice?: () => void
  showP2PUpdateNotice: boolean
  p2pUpdateNoticeKey?: string
  onDismissP2PUpdateNotice: () => void
  showMissingKeyNotice: boolean
  onDismissMissingKeyNotice: () => void
}

function ReceiveNotices({
  showExpiredNotice,
  isP2PMode,
  onDismissExpiredNotice,
  showP2PUpdateNotice,
  p2pUpdateNoticeKey,
  onDismissP2PUpdateNotice,
  showMissingKeyNotice,
  onDismissMissingKeyNotice,
}: ReceiveNoticesProps) {
  if (!showExpiredNotice && !showP2PUpdateNotice && !showMissingKeyNotice) return null

  return (
    <div className="received-notice-stack">
      {showExpiredNotice && (
        <ReceiveNotice
          tone="danger"
          title={isP2PMode ? "The transfer limit has been reached" : "The file has expired"}
          dismissLabel="Close expired notice"
          onDismiss={onDismissExpiredNotice}
        >
          {isP2PMode ? "This P2P link is no longer available." : "The file has been permanently deleted."}
        </ReceiveNotice>
      )}
      {showP2PUpdateNotice && p2pUpdateNoticeKey && (
        <ReceiveNotice
          key={p2pUpdateNoticeKey}
          title="New version available"
          icon={<RefreshIcon />}
          dismissLabel="Dismiss new version notice"
          onDismiss={onDismissP2PUpdateNotice}
          autoDismissAfterMs={6000}
          scrollToPageBottomOnShow
        >
          The sender updated this file. You can keep the current version or receive the latest one below.
        </ReceiveNotice>
      )}
      {showMissingKeyNotice && (
        <ReceiveNotice
          tone="danger"
          title="Decryption key is missing"
          dismissLabel="Dismiss missing decryption key notice"
          onDismiss={onDismissMissingKeyNotice}
        >
          This file is encrypted. Open the complete share URL, including # and the key after it, to decrypt the file.
        </ReceiveNotice>
      )}
    </div>
  )
}

interface DisplayTopbarProps {
  indexPageTitle: string
  iconLinkClass: string
  name: string
  ext?: string
  titleDisplayFilename?: string
  isP2PMode: boolean
  isDecrypted: PasteDisplayState["isDecrypted"]
  modeSelection: ReturnType<typeof useDarkModeSelection>[1]
  setModeSelection: ReturnType<typeof useDarkModeSelection>[2]
  displayUrl: string
}

function DisplayTopbar({
  indexPageTitle,
  iconLinkClass,
  name,
  ext,
  titleDisplayFilename,
  isP2PMode,
  isDecrypted,
  modeSelection,
  setModeSelection,
  displayUrl,
}: DisplayTopbarProps) {
  return (
    <PageTopbar
      heading={
        <>
          <a href="/" aria-label={indexPageTitle} className={`${iconLinkClass} md:hidden shrink-0`}>
            <HomeIcon className="size-6" />
          </a>
          <Link href="/" className="hidden shrink-0 text-default-500 md:inline">
            {indexPageTitle}
          </Link>
          <span className="mx-2 shrink-0">{" / "}</span>
          <span className="min-w-0 truncate" title={titleDisplayFilename ? name : name + (ext ?? "")}>
            {titleDisplayFilename ? name : name + (ext ?? "")}
          </span>
          {titleDisplayFilename && (
            <>
              <span className="mx-2 shrink-0">{" / "}</span>
              <span className="truncate min-w-0" title={titleDisplayFilename}>
                {titleDisplayFilename}
              </span>
            </>
          )}
          <span className="ml-1 shrink-0">
            {isP2PMode
              ? " (P2P)"
              : isDecrypted === "decrypted"
                ? " (Decrypted)"
                : isDecrypted === "encrypted"
                  ? " (Encrypted)"
                  : ""}
          </span>
        </>
      }
      actions={
        <>
          <DarkModeToggle modeSelection={modeSelection} setModeSelection={setModeSelection} />
          {displayUrl && (
            <QrCodeTooltip value={displayUrl} placement="bottom" className={iconLinkClass} tooltip="Show QR code" />
          )}
          <Tooltip content="Share this page" placement="bottom">
            <WebShareButton title={titleDisplayFilename || name} url={displayUrl} className={iconLinkClass} plain />
          </Tooltip>
        </>
      }
    />
  )
}

export function DisplayPasteView(props: DisplayPasteViewProps) {
  const {
    forceShowBinary,
    name,
    ext,
    filename,
    config,
    showExpiredNotice,
    showMissingEncryptionKeyNotice,
    paste: {
      file: pasteFile,
      contentBuffer: pasteContentBuffer,
      lang: pasteLang,
      isFileBinary,
      guessedEncoding,
      isDecrypted,
      isLoading,
      isDownloading,
      pendingInfo,
      mediaInfo,
      metaFilename,
      originalFiles,
    },
    p2p: {
      isMode: isP2PMode,
      status: p2pStatus,
      connectionRoute: p2pConnectionRoute,
      meta: p2pMeta,
      updateMeta: p2pUpdateMeta,
      transferHistory: p2pTransferHistory = [],
      progress: p2pProgress,
      file: p2pFile,
      isPaused: isP2PPaused,
      isPausing: isP2PPausing,
      isReconnecting: isP2PReconnecting,
      isAcceptingUpdate: isP2PAcceptingUpdate,
    } = {},
    actions: {
      setForceShowBinary,
      dismissExpiredNotice: onDismissExpiredNotice,
      downloadP2P: onP2PDownload,
      pauseP2P: onP2PPause,
      resumeP2P: onP2PResume,
      terminateP2P: onP2PTerminate,
      acceptP2PUpdate: onP2PAcceptUpdate,
      loadP2PAnyway: onP2PLoadAnyway,
      loadPasteAnyway: onLoadAnyway,
      downloadPaste: onDownloadPaste,
    },
  } = props

  const indexPageTitle = config.INDEX_PAGE_TITLE || "Pastebin"

  const [, modeSelection, setModeSelection] = useDarkModeSelection()
  const displayLang = pasteLang
  const hljs = useHljsForLang(displayLang)
  const [downloadUrl, setDownloadUrl] = useState<string>("#")
  const [displayUrl, setDisplayUrl] = useState<string>("")
  const [isNativeDownloadDebounced, setNativeDownloadDebounced] = useState(false)
  const [dismissedP2PUpdateNotice, setDismissedP2PUpdateNotice] = useState<string>()
  const [isMissingEncryptionKeyNoticeDismissed, setMissingEncryptionKeyNoticeDismissed] = useState(false)
  const nativeDownloadDebouncedRef = useRef(false)
  const nativeDownloadDebounceTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (typeof window !== "undefined") {
      setDisplayUrl(window.location.href)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (nativeDownloadDebounceTimer.current !== undefined) {
        window.clearTimeout(nativeDownloadDebounceTimer.current)
      }
    }
  }, [])

  // Create and cleanup blob URL
  const downloadableFile = p2pFile || pasteFile

  useEffect(() => {
    if (downloadableFile && typeof window !== "undefined" && URL.createObjectURL) {
      const url = URL.createObjectURL(mediaPreviewBlob(downloadableFile))
      setDownloadUrl(url)
      return () => {
        if (URL.revokeObjectURL) URL.revokeObjectURL(url)
      }
    }
  }, [downloadableFile])

  const pasteMediaKind = pasteFile ? mediaKindOfFile(pasteFile) : null
  const mediaInfoKind = mediaInfo ? mediaKindOfType(mediaInfo.contentType) : null
  const showFileContent = pasteFile !== undefined && pasteMediaKind === null && (!isFileBinary || forceShowBinary)
  const pasteStringContent = useMemo(
    () => (pasteContentBuffer ? new TextDecoder().decode(pasteContentBuffer) : undefined),
    [pasteContentBuffer],
  )
  const highlightedHTML = useMemo(() => {
    const html = pasteStringContent ? highlightHTML(hljs, displayLang, pasteStringContent) : ""
    return html
  }, [displayLang, hljs, pasteStringContent])
  const pasteLineCount = useMemo(() => countTextLines(pasteStringContent ?? ""), [pasteStringContent])
  const previewOriginalFiles = isP2PMode ? p2pMeta?.originalFiles : originalFiles
  const hasOriginalFiles = previewOriginalFiles !== undefined && previewOriginalFiles.length > 0
  const isZipArchive = isZipBuffer(pasteContentBuffer)
  const isDownloadActionDisabled = isLoading || isDownloading
  const isP2PDownloading = p2pProgress !== undefined && !p2pFile
  const isP2PRepairing = p2pStatus?.startsWith("Repairing") ?? false
  const showP2PPanel = isP2PMode && !(p2pFile && (showFileContent || pasteMediaKind !== null))
  const canSharePreviewContent = isP2PMode || (pasteFile !== undefined && (showFileContent || pasteMediaKind !== null))
  const showPrimaryContent =
    !isP2PMode || p2pTransferHistory.length === 0 || p2pMeta !== undefined || pasteFile !== undefined || isLoading
  const p2pTransferStatus: P2PTransferStatus = p2pFile
    ? "DONE"
    : isP2PPaused
      ? "PAUSED"
      : isP2PReconnecting
        ? "RECONNECTING"
        : isP2PRepairing
          ? "REPAIRING"
          : p2pProgress
            ? p2pProgress.doneBytes >= p2pProgress.totalBytes
              ? "VERIFYING"
              : "DOWNLOADING"
            : "READY"
  const p2pUpdateNoticeKey = p2pUpdateMeta
    ? p2pUpdateMeta.revision ||
      [p2pUpdateMeta.name, p2pUpdateMeta.size, p2pUpdateMeta.lastModified, p2pUpdateMeta.type].join(":")
    : undefined
  const showP2PUpdateNotice =
    !showExpiredNotice &&
    !isP2PAcceptingUpdate &&
    p2pUpdateNoticeKey !== undefined &&
    dismissedP2PUpdateNotice !== p2pUpdateNoticeKey
  const showMissingKeyNotice =
    !showExpiredNotice && !!showMissingEncryptionKeyNotice && !isMissingEncryptionKeyNoticeDismissed

  function onNativeDownloadClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (nativeDownloadDebouncedRef.current) {
      e.preventDefault()
      return
    }
    nativeDownloadDebouncedRef.current = true
    setNativeDownloadDebounced(true)
    if (nativeDownloadDebounceTimer.current !== undefined) {
      window.clearTimeout(nativeDownloadDebounceTimer.current)
    }
    nativeDownloadDebounceTimer.current = window.setTimeout(() => {
      nativeDownloadDebouncedRef.current = false
      setNativeDownloadDebounced(false)
      nativeDownloadDebounceTimer.current = undefined
    }, 1000)
  }

  const binaryFileIndicator = pasteFile && (
    <ReceivedFilePlaceholder
      summary={`${hasOriginalFiles ? itemCountLabel(previewOriginalFiles.length) : pasteFile.name} (${formatSize(pasteFile.size)})`}
      originalFiles={hasOriginalFiles ? previewOriginalFiles : undefined}
    >
      <div className="text-sm">
        {isZipArchive
          ? "Not a renderable file (application/zip)."
          : `This file seems to be binary or not in UTF-8${guessedEncoding ? ` (${guessedEncoding} guessed).` : "."}`}
      </div>
      <ActionRow className={isZipArchive ? "mt-4" : "mt-3"}>
        <a
          href={downloadUrl}
          download={pasteFile.name}
          className={`${actionControlClassName()} ${isNativeDownloadDebounced ? "pointer-events-none opacity-50" : ""}`}
          aria-disabled={isNativeDownloadDebounced}
          onClick={onNativeDownloadClick}
        >
          Download
        </a>
        <ActionButton
          type="button"
          variant="tertiary"
          className="whitespace-nowrap"
          onClick={() => setForceShowBinary(true)}
        >
          Click to show
        </ActionButton>
      </ActionRow>
    </ReceivedFilePlaceholder>
  )

  const contentDisplayFilename = hasOriginalFiles
    ? itemCountLabel(previewOriginalFiles.length)
    : filename || metaFilename
  const titleDisplayFilename = hasOriginalFiles
    ? itemCountLabel(previewOriginalFiles.length)
    : filenameForTitle(filename || metaFilename)
  const placeholderName = contentDisplayFilename || (ext ? name + ext : name)
  const rawDownloadUrl = pendingInfo || mediaInfo ? `${(pendingInfo ?? mediaInfo)!.rawUrl}?a` : "#"
  const previewSaveAction = downloadableFile ? (
    <SaveFileLink
      href={downloadUrl}
      filename={downloadableFile.name}
      disabled={isNativeDownloadDebounced}
      onClick={onNativeDownloadClick}
    />
  ) : onDownloadPaste ? (
    <ActionButton type="button" className="gap-2" disabled={isDownloadActionDisabled} onClick={() => onDownloadPaste()}>
      <DownloadIcon className="size-6" aria-hidden="true" />
      {isDownloading ? "Saving..." : "Save"}
    </ActionButton>
  ) : (
    <SaveFileLink
      href={rawDownloadUrl}
      filename={placeholderName}
      disabled={isNativeDownloadDebounced}
      onClick={onNativeDownloadClick}
    />
  )
  const placeholderReason = (() => {
    if (!pendingInfo) return ""
    const ct = pendingInfo.contentType
    if (
      !ct?.startsWith("text/") &&
      !ct?.startsWith("image/") &&
      !ct?.startsWith("audio/") &&
      !ct?.startsWith("video/")
    ) {
      return `Not a renderable file${ct ? ` (${ct})` : ""}.`
    }
    if (pendingInfo.isReadLimited) {
      return "Paste has a limited number of reads."
    }
    return "Paste is too large to load automatically."
  })()
  const pendingFileIndicator = pendingInfo && !pasteFile && (
    <ReceivedFilePlaceholder
      summary={`${placeholderName}${sizeSuffix(pendingInfo.sizeBytes)}`}
      originalFiles={hasOriginalFiles ? previewOriginalFiles : undefined}
      bodyClassName="w-full max-w-full"
    >
      <div className="text-sm">{placeholderReason}</div>
      <ActionRow className="mt-2">
        {onDownloadPaste ? (
          <ActionButton
            type="button"
            aria-label="Download file"
            disabled={isDownloadActionDisabled}
            onClick={() => onDownloadPaste()}
          >
            {isDownloading ? "Downloading..." : "Download"}
          </ActionButton>
        ) : (
          <a
            href={`${pendingInfo.rawUrl}?a`}
            className={`${actionControlClassName()} ${isNativeDownloadDebounced ? "pointer-events-none opacity-50" : ""}`}
            aria-disabled={isNativeDownloadDebounced}
            onClick={onNativeDownloadClick}
          >
            Download
          </a>
        )}
        {onLoadAnyway && (
          <ActionButton type="button" variant="tertiary" disabled={isLoading} onClick={() => onLoadAnyway()}>
            {isLoading ? "loading..." : "load anyway"}
          </ActionButton>
        )}
      </ActionRow>
    </ReceivedFilePlaceholder>
  )

  const iconLinkClass = iconControlClassName
  return (
    <PageShell className="p-2">
      <ReceiveNotices
        showExpiredNotice={!!showExpiredNotice}
        isP2PMode={!!isP2PMode}
        onDismissExpiredNotice={onDismissExpiredNotice}
        showP2PUpdateNotice={showP2PUpdateNotice}
        p2pUpdateNoticeKey={p2pUpdateNoticeKey}
        onDismissP2PUpdateNotice={() => setDismissedP2PUpdateNotice(p2pUpdateNoticeKey)}
        showMissingKeyNotice={showMissingKeyNotice}
        onDismissMissingKeyNotice={() => setMissingEncryptionKeyNoticeDismissed(true)}
      />
      <PageContainer className="max-w-[64rem]">
        <DisplayTopbar
          indexPageTitle={indexPageTitle}
          iconLinkClass={iconLinkClass}
          name={name}
          ext={ext}
          titleDisplayFilename={titleDisplayFilename}
          isP2PMode={!!isP2PMode}
          isDecrypted={isDecrypted}
          modeSelection={modeSelection}
          setModeSelection={setModeSelection}
          displayUrl={displayUrl}
        />
        <div className="my-4">
          {p2pTransferHistory.map((transfer, index) => (
            <P2PTransferHistoryCard
              key={transfer.id}
              transfer={transfer}
              className={index === 0 ? undefined : "mt-4"}
            />
          ))}
          {showPrimaryContent && (
            <ReceiveCard className={p2pTransferHistory.length > 0 ? "mt-4" : ""}>
              {isLoading ? (
                <div className="h-[10em] flex items-center justify-center">
                  <CircularProgress label={"Loading..."} />
                </div>
              ) : showP2PPanel ? (
                <P2PReceiveStatusContent
                  status={p2pStatus || "Looking for the sender..."}
                  meta={p2pMeta}
                  connectionRoute={p2pConnectionRoute}
                  progress={p2pProgress}
                  transferStatus={p2pTransferStatus}
                  actions={
                    p2pFile ? (
                      <ActionRow preview className="mt-2">
                        <SaveFileLink
                          href={downloadUrl}
                          filename={p2pFile.name}
                          disabled={isNativeDownloadDebounced}
                          onClick={onNativeDownloadClick}
                        />
                        <WebShareButton title={p2pFile.name} file={p2pFile} />
                        {onP2PLoadAnyway && (
                          <ActionButton type="button" variant="tertiary" onClick={onP2PLoadAnyway}>
                            load anyway
                          </ActionButton>
                        )}
                      </ActionRow>
                    ) : isP2PDownloading ? (
                      <ActionRow className="mt-2">
                        <ActionButton
                          type="button"
                          variant="secondary"
                          disabled={isP2PPausing}
                          onClick={() => (isP2PPaused ? onP2PResume?.() : onP2PPause?.())}
                        >
                          {isP2PPausing ? "Pausing..." : isP2PPaused ? "Resume" : "Pause"}
                        </ActionButton>
                        <ActionButton type="button" variant="danger" onClick={() => onP2PTerminate?.()}>
                          Terminate
                        </ActionButton>
                      </ActionRow>
                    ) : (
                      <ActionButton
                        type="button"
                        className="mt-2"
                        disabled={!p2pMeta}
                        onClick={() => onP2PDownload?.()}
                      >
                        Receive
                      </ActionButton>
                    )
                  }
                />
              ) : mediaInfo && !pasteFile && mediaInfoKind ? (
                <ReceivedMediaPreview
                  kind={mediaInfoKind}
                  src={mediaInfo.rawUrl}
                  name={placeholderName}
                  displayName={placeholderName}
                  detail={mediaInfo.sizeBytes === null ? mediaInfo.contentType : formatSize(mediaInfo.sizeBytes)}
                  saveAction={previewSaveAction}
                />
              ) : pasteFile && pasteMediaKind ? (
                <ReceivedMediaPreview
                  kind={pasteMediaKind}
                  src={downloadUrl}
                  name={pasteFile.name}
                  displayName={contentDisplayFilename || pasteFile.name}
                  detail={formatSize(pasteFile.size)}
                  saveAction={previewSaveAction}
                  shareAction={
                    canSharePreviewContent ? <WebShareButton title={pasteFile.name} file={pasteFile} /> : undefined
                  }
                  originalFiles={hasOriginalFiles ? previewOriginalFiles : undefined}
                />
              ) : pendingInfo && !pasteFile ? (
                pendingFileIndicator
              ) : (
                pasteFile &&
                (showFileContent ? (
                  <ReceivedPreviewFrame
                    name={contentDisplayFilename || pasteFile.name}
                    detail={formatSize(pasteFile.size)}
                    extra={
                      <>
                        {displayLang && (
                          <span className="inline-flex items-center gap-2 text-sm text-default-500">
                            <span aria-hidden="true">·</span>
                            <span>{displayLang}</span>
                          </span>
                        )}
                        {forceShowBinary && (
                          <button className="text-sm text-primary" onClick={() => setForceShowBinary(false)}>
                            Click to hide
                          </button>
                        )}
                      </>
                    }
                    contentClassName="received-preview-text"
                    actions={
                      <>
                        {previewSaveAction}
                        <CopyWidget label="Copy" appearance="action" getCopyContent={() => pasteStringContent!} />
                        {canSharePreviewContent &&
                          (isFileBinary ? (
                            <WebShareButton title={pasteFile.name} file={pasteFile} />
                          ) : (
                            <WebShareButton title={pasteFile.name} text={pasteStringContent} file={pasteFile} />
                          ))}
                      </>
                    }
                  >
                    {hasOriginalFiles && (
                      <OriginalFileList files={previewOriginalFiles} className="mb-3 max-h-48 overflow-auto" />
                    )}
                    <ReceivedTextContent lineCount={pasteLineCount} html={highlightedHTML} />
                  </ReceivedPreviewFrame>
                ) : (
                  binaryFileIndicator
                ))
              )}
            </ReceiveCard>
          )}
          {isP2PMode && p2pUpdateMeta && (
            <P2PReceiveStatusCard
              className="mt-4"
              status="New version from sender."
              meta={p2pUpdateMeta}
              connectionRoute={p2pConnectionRoute}
              transferStatus="READY"
              actions={
                <ActionButton
                  type="button"
                  className="mt-2"
                  disabled={isP2PAcceptingUpdate}
                  onClick={onP2PAcceptUpdate}
                >
                  {isP2PAcceptingUpdate ? "Switching..." : "Receive"}
                </ActionButton>
              }
            />
          )}
        </div>
      </PageContainer>
    </PageShell>
  )
}
