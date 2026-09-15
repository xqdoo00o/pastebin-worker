import { useEffect, useState, type ReactNode } from "react"

import { itemCountLabel } from "../../shared/format.js"
import type { P2PConnectionRoute, P2PFileMeta, P2PProgress, P2PTransferHistoryItem } from "../utils/p2p/protocol.js"
import { formatSize } from "../utils/utils.js"
import { WebShareButton } from "./WebShareButton.js"
import { P2PProgressBar } from "./P2PProgressBar.js"
import { ActionRow, ReceiveCard, ReceivedFilePlaceholder, SaveFileLink } from "./ReceivedPreview.js"

export interface P2PReceiveStatusContentProps {
  status: string
  meta?: P2PFileMeta
  connectionRoute?: P2PConnectionRoute
  progress?: P2PProgress
  transferStatus: string
  actions?: ReactNode
}

/** Shared P2P receiver status body for the active transfer, updates, and history. */
export function P2PReceiveStatusContent({
  status,
  meta,
  connectionRoute,
  progress,
  transferStatus,
  actions,
}: P2PReceiveStatusContentProps) {
  if (meta) {
    const originalFiles = meta.originalFiles?.length ? meta.originalFiles : undefined
    const summary = `${originalFiles ? itemCountLabel(originalFiles.length) : meta.name} (${formatSize(meta.size)})`
    return (
      <ReceivedFilePlaceholder summary={summary} originalFiles={originalFiles} bodyClassName="w-full max-w-2xl">
        <div className="text-sm text-default-500">{status}</div>
        <div className="mt-3 w-full">
          <P2PProgressBar
            progress={progress}
            label={meta.senderBrowser}
            connectionRoute={connectionRoute}
            status={transferStatus}
            reserveTransferStatsSpace
          />
        </div>
        {actions}
      </ReceivedFilePlaceholder>
    )
  }

  return (
    <div className="flex min-h-[14em] w-full flex-col items-center justify-center px-4 text-center">
      <div className="text-lg font-medium">P2P receiver</div>
      <div className="mt-2 text-sm text-default-500">{status}</div>
      {actions}
    </div>
  )
}

export function P2PReceiveStatusCard({ className, ...props }: P2PReceiveStatusContentProps & { className?: string }) {
  return (
    <ReceiveCard className={className}>
      <P2PReceiveStatusContent {...props} />
    </ReceiveCard>
  )
}

export function P2PTransferHistoryCard({
  transfer,
  className,
}: {
  transfer: P2PTransferHistoryItem
  className?: string
}) {
  const [downloadUrl, setDownloadUrl] = useState("")

  useEffect(() => {
    if (!transfer.file || typeof window === "undefined" || !URL.createObjectURL) {
      setDownloadUrl("")
      return
    }
    const url = URL.createObjectURL(transfer.file)
    setDownloadUrl(url)
    return () => {
      if (URL.revokeObjectURL) URL.revokeObjectURL(url)
    }
  }, [transfer.file])

  return (
    <P2PReceiveStatusCard
      className={className}
      status={transfer.status}
      meta={transfer.meta}
      connectionRoute={transfer.connectionRoute}
      progress={transfer.progress}
      transferStatus={transfer.transferStatus}
      actions={
        transfer.file &&
        downloadUrl && (
          <ActionRow preview className="mt-3">
            <SaveFileLink href={downloadUrl} filename={transfer.file.name} />
            <WebShareButton title={transfer.file.name} file={transfer.file} />
          </ActionRow>
        )
      }
    />
  )
}
