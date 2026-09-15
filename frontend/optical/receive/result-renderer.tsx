import { useLayoutEffect, useMemo, useRef, useState } from "react"

import { RefreshIcon } from "../../components/icons.js"
import { CopyWidget } from "../../components/CopyWidget.js"
import {
  MediaElement,
  ActionRow,
  ReceivedFilePlaceholder,
  ReceivedPreviewFrame,
  ReceivedTextContent,
  SaveFileLink,
} from "../../components/ReceivedPreview.js"
import { ActionButton } from "../../components/ui/index.js"
import { WebShareButton } from "../../components/WebShareButton.js"
import { countTextLines } from "../../components/LineNumbers.js"
import { classifyReceivedFile, classifyStoredReceivedFile, decodeReceivedText } from "../../utils/filePreview.js"
import { formatSize } from "../../utils/utils.js"
import { triggerUrlDownload } from "../../utils/download.js"
import { highlightHTML, useHljsForLang } from "../../utils/highlight.js"
import { highlightLanguageFromMimeType } from "../../../shared/fileType.js"
import type { OpticalFile } from "../shared/protocol.js"

type ReceivedFilePreview = ReturnType<typeof classifyReceivedFile>
const NO_DISALLOWED_MIME_TYPES: readonly string[] = []

function DeferredPreview({
  preview,
  blob,
  onTextLoaded,
}: {
  preview: ReceivedFilePreview
  blob: Blob
  onTextLoaded: (text: string) => void
}) {
  const [loadState, setLoadState] = useState<"idle" | "loading" | "invalid">("idle")
  const isDeferredText = preview.kind === "deferred-text"
  const title = isDeferredText ? "Large text file" : "Preview unavailable"
  const description = isDeferredText
    ? "Automatic preview is paused to keep this page responsive."
    : "This file type can't be displayed here. A download was started automatically."

  async function loadText() {
    setLoadState("loading")
    try {
      onTextLoaded(decodeReceivedText(new Uint8Array(await blob.arrayBuffer())))
    } catch {
      setLoadState("invalid")
    }
  }

  return (
    <ReceivedFilePlaceholder bodyClassName="deferred-preview received-preview-empty-state">
      <div className="received-preview-empty-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {isDeferredText && loadState !== "invalid" && (
        <ActionButton
          type="button"
          variant="secondary"
          className="received-preview-empty-action"
          disabled={loadState === "loading"}
          onClick={() => void loadText()}
        >
          {loadState === "loading" ? "Loading preview…" : "Preview anyway"}
        </ActionButton>
      )}
      {loadState === "invalid" && (
        <span role="alert" className="received-preview-empty-error">
          This file is not valid UTF-8.
        </span>
      )}
    </ReceivedFilePlaceholder>
  )
}

function OpticalReceivedFileView({
  file,
  preview,
  blob,
  url,
  summary,
  onRestart,
  onDownload,
}: {
  file: OpticalFile | File
  preview: ReceivedFilePreview
  blob: Blob
  url: string
  summary: string
  onRestart: () => void
  onDownload?: () => void
}) {
  const [loadedText, setLoadedText] = useState<string | undefined>(preview.kind === "text" ? preview.text : undefined)
  const highlightLanguage = highlightLanguageFromMimeType(file.type)
  const hljs = useHljsForLang(highlightLanguage)
  const highlightedHTML = useMemo(
    () => (loadedText === undefined ? undefined : highlightHTML(hljs, highlightLanguage, loadedText)),
    [highlightLanguage, hljs, loadedText],
  )
  const shareFile = useMemo(() => new File([blob], file.name, { type: blob.type }), [blob, file.name])
  const actions = (
    <>
      <SaveFileLink href={url} filename={file.name} onClick={onDownload} />
      {loadedText !== undefined && (
        <CopyWidget
          appearance="action"
          label="Copy"
          copiedLabel="Copied"
          failedLabel="Failed"
          getCopyContent={() => loadedText}
        />
      )}
      {loadedText !== undefined ? (
        <WebShareButton title={file.name} text={loadedText} file={shareFile} />
      ) : (
        <WebShareButton title={file.name} file={shareFile} />
      )}
      <ActionButton type="button" variant="tertiary" isIconOnly aria-label="Other" title="Other" onClick={onRestart}>
        <RefreshIcon className="size-6 text-default-600" aria-hidden="true" />
      </ActionButton>
    </>
  )

  return (
    <ReceivedPreviewFrame
      name={file.name}
      detail={summary}
      verificationLabel="XXH3 verified"
      contentClassName={loadedText !== undefined ? "received-preview-text" : ""}
      actions={actions}
    >
      {preview.kind === "image" ? (
        <MediaElement kind="image" src={url} name={file.name} accessibleName={`Received file preview: ${file.name}`} />
      ) : preview.kind === "video" || preview.kind === "audio" ? (
        <MediaElement kind={preview.kind} src={url} name={file.name} accessibleName={`Received file: ${file.name}`} />
      ) : loadedText !== undefined ? (
        <ReceivedTextContent lineCount={countTextLines(loadedText)} html={highlightedHTML} />
      ) : (
        <DeferredPreview preview={preview} blob={blob} onTextLoaded={setLoadedText} />
      )}
    </ReceivedPreviewFrame>
  )
}

export function OpticalReceivedFailure({ onRestart }: { onRestart: () => void }) {
  return (
    <div className="received-preview-layout">
      <div className="received-failure-title">Transfer failed</div>
      <div className="received-preview-placeholder">
        Nothing usable came out of that stream. Restart the sender, then scan it again — a partial transfer costs
        nothing but the time.
      </div>
      <ActionRow preview single>
        <ActionButton type="button" className="gap-2" onClick={onRestart}>
          <RefreshIcon className="size-6" aria-hidden="true" />
          Try again
        </ActionButton>
      </ActionRow>
    </div>
  )
}

export interface OpticalReceivedFileResultProps {
  file: OpticalFile | File
  containerBytes: number
  seconds: number
  onRestart: () => void
  onDownload?: () => void
  disallowedMimeTypes?: readonly string[]
}

/** React-owned receiver result used by the standalone receive page. */
export function OpticalReceivedFileResult({
  file,
  containerBytes,
  seconds,
  onRestart,
  onDownload,
  disallowedMimeTypes = NO_DISALLOWED_MIME_TYPES,
}: OpticalReceivedFileResultProps) {
  const presentation = useMemo(
    () => createReceivedPresentation(file, containerBytes, seconds, disallowedMimeTypes),
    [containerBytes, disallowedMimeTypes, file, seconds],
  )
  const url = useMemo(() => URL.createObjectURL(presentation.blob), [presentation.blob])
  const onDownloadRef = useRef(onDownload)
  const autoDownloadedUrlRef = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    onDownloadRef.current = onDownload
  }, [onDownload])

  useLayoutEffect(() => {
    if (presentation.preview.kind === "download" && autoDownloadedUrlRef.current !== url) {
      autoDownloadedUrlRef.current = url
      onDownloadRef.current?.()
      triggerUrlDownload(url, file.name)
    }
    return () => URL.revokeObjectURL(url)
  }, [file.name, presentation.preview.kind, url])

  return (
    <OpticalReceivedFileView
      file={file}
      preview={presentation.preview}
      blob={presentation.blob}
      url={url}
      summary={presentation.summary}
      onRestart={onRestart}
      onDownload={onDownload}
    />
  )
}

function createReceivedPresentation(
  file: OpticalFile | File,
  containerBytes: number,
  seconds: number,
  disallowedMimeTypes: readonly string[],
) {
  const diskBacked = file instanceof File
  const preview = diskBacked
    ? classifyStoredReceivedFile(file, disallowedMimeTypes)
    : classifyReceivedFile(file.name, file.type, file.bytes, disallowedMimeTypes)
  const rate = (containerBytes / 1024 / seconds).toFixed(1)
  const size = diskBacked ? file.size : file.bytes.length
  const highlightLanguage = highlightLanguageFromMimeType(file.type)
  const languageNote = highlightLanguage ? ` · ${highlightLanguage}` : ""
  const summary = `${formatSize(size)}${languageNote} · ${rate} KB/s`
  const blob = diskBacked
    ? file.type === preview.contentType
      ? file
      : new Blob([file], { type: preview.contentType })
    : new Blob([file.bytes as BlobPart], { type: preview.contentType })
  return { blob, preview, summary }
}
