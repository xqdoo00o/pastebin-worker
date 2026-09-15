import { useEffect, useRef, type HTMLAttributes, type MouseEventHandler, type ReactNode } from "react"

import type { OriginalFileInfo } from "../../shared/interfaces.js"
import type { MediaKind } from "../utils/filePreview.js"
import { DownloadIcon, InfoIcon, XIcon } from "./icons.js"
import { FileTree } from "./FileTree.js"
import { LineNumbers, lineNumberOffset } from "./LineNumbers.js"
import { actionControlClassName } from "./ui/index.js"

export function MediaElement({
  kind,
  src,
  name,
  accessibleName = name,
}: {
  kind: MediaKind
  src: string
  name: string
  accessibleName?: string
}) {
  if (kind === "image") {
    return <img src={src} alt={accessibleName} className="received-preview-media" />
  }
  if (kind === "audio") {
    return <audio src={src} controls className="received-preview-audio" aria-label={accessibleName} />
  }
  return <video src={src} controls playsInline className="received-preview-media" aria-label={accessibleName} />
}

export function SaveFileLink({
  href,
  filename,
  disabled = false,
  onClick,
  label = "Save",
}: {
  href: string
  filename: string
  disabled?: boolean
  onClick?: MouseEventHandler<HTMLAnchorElement>
  label?: ReactNode
}) {
  return (
    <a
      href={href}
      download={filename}
      className={`${actionControlClassName()} gap-2 ${disabled ? "pointer-events-none opacity-50" : ""}`}
      aria-disabled={disabled}
      onClick={onClick}
    >
      <DownloadIcon className="size-6" aria-hidden="true" />
      {label}
    </a>
  )
}

function ReceivedPreviewHeader({
  name,
  detail,
  extra,
  verificationLabel = "Content verified",
}: {
  name: string
  detail: string
  extra?: ReactNode
  verificationLabel?: string
}) {
  return (
    <div className="received-preview-header">
      <div className="received-preview-file-info">
        <strong title={name}>{name}</strong>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="received-preview-detail">{detail}</span>
          {extra}
        </div>
      </div>
      <span className="received-verified-badge" aria-label={verificationLabel}>
        Verified
      </span>
    </div>
  )
}

export function ReceiveCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`relative w-full rounded-lg bg-default-100 p-3 ${className}`}>{children}</div>
}

export function ActionRow({
  preview = false,
  single = false,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & { preview?: boolean; single?: boolean }) {
  return (
    <div
      className={`action-button-row ${preview ? "received-preview-actions" : ""} ${single ? "single" : ""} ${className}`}
      {...props}
    />
  )
}

export function ReceiveNotice({
  title,
  children,
  tone = "primary",
  icon,
  dismissLabel,
  onDismiss,
  autoDismissAfterMs,
  scrollToPageBottomOnShow = false,
}: {
  title: string
  children: ReactNode
  tone?: "primary" | "danger"
  icon?: ReactNode
  dismissLabel?: string
  onDismiss?: () => void
  autoDismissAfterMs?: number
  scrollToPageBottomOnShow?: boolean
}) {
  const onDismissRef = useRef(onDismiss)

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!autoDismissAfterMs || autoDismissAfterMs <= 0) return
    const timer = window.setTimeout(() => onDismissRef.current?.(), autoDismissAfterMs)
    return () => window.clearTimeout(timer)
  }, [autoDismissAfterMs])

  useEffect(() => {
    if (!scrollToPageBottomOnShow) return
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
  }, [scrollToPageBottomOnShow])

  return (
    <div role="status" aria-live="polite" className={`received-notice received-notice-${tone}`}>
      <span className="received-notice-icon" aria-hidden="true">
        {icon ?? <InfoIcon />}
      </span>
      <div className="received-notice-content">
        <div className="received-notice-title">{title}</div>
        <div className="received-notice-description">{children}</div>
      </div>
      {onDismiss && (
        <button type="button" aria-label={dismissLabel} className="received-notice-dismiss" onClick={onDismiss}>
          <XIcon />
        </button>
      )}
    </div>
  )
}

export function OriginalFileList({
  files,
  className = "max-h-48 w-full max-w-[32rem] overflow-auto text-left",
}: {
  files: OriginalFileInfo[]
  className?: string
}) {
  return <FileTree files={files} className={className} />
}

export function ReceivedFilePlaceholder({
  summary,
  originalFiles,
  bodyClassName = "w-fit",
  children,
}: {
  summary?: ReactNode
  originalFiles?: OriginalFileInfo[]
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <div className="received-preview-placeholder">
      {summary && <div className="received-preview-placeholder-summary text-foreground">{summary}</div>}
      {originalFiles && originalFiles.length > 0 && <OriginalFileList files={originalFiles} />}
      <div className={bodyClassName}>{children}</div>
    </div>
  )
}

export function ReceivedPreviewFrame({
  name,
  detail,
  extra,
  verificationLabel,
  contentClassName = "",
  actionClassName = "",
  actions,
  children,
}: {
  name: string
  detail: string
  extra?: ReactNode
  verificationLabel?: string
  contentClassName?: string
  actionClassName?: string
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <div className="received-preview-layout">
      <ReceivedPreviewHeader name={name} detail={detail} extra={extra} verificationLabel={verificationLabel} />
      <div className={`received-preview-content ${contentClassName}`}>{children}</div>
      <ActionRow preview className={actionClassName}>
        {actions}
      </ActionRow>
    </div>
  )
}

export function ReceivedTextContent({ lineCount, text, html }: { lineCount: number; text?: string; html?: string }) {
  const offset = lineNumberOffset(lineCount)
  return (
    <div className="received-preview-code">
      <pre
        role="article"
        style={{ marginLeft: offset, width: `calc(100% - ${offset})` }}
        className="received-preview-note"
        {...(html === undefined ? {} : { dangerouslySetInnerHTML: { __html: html } })}
      >
        {html === undefined ? text : undefined}
      </pre>
      <LineNumbers lineCount={lineCount} className="received-preview-line-numbers" style={{ width: offset }} />
    </div>
  )
}

export function ReceivedMediaPreview({
  kind,
  src,
  name,
  displayName,
  detail,
  saveAction,
  shareAction,
  originalFiles,
}: {
  kind: MediaKind
  src: string
  name: string
  displayName: string
  detail: string
  saveAction: ReactNode
  shareAction?: ReactNode
  originalFiles?: OriginalFileInfo[]
}) {
  return (
    <ReceivedPreviewFrame
      name={displayName}
      detail={detail}
      actions={
        <>
          {saveAction}
          {shareAction}
        </>
      }
      actionClassName={shareAction ? "" : "single"}
    >
      {originalFiles && <OriginalFileList files={originalFiles} className="mb-3 max-h-48 overflow-auto" />}
      <MediaElement kind={kind} src={src} name={name} />
    </ReceivedPreviewFrame>
  )
}
