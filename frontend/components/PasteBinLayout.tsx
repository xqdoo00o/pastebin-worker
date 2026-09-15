import type { ReactNode } from "react"
import type { PublicEnv } from "../../shared/interfaces.js"
import { getMaxExpirationReadable } from "../utils/utils.js"
import { Link } from "./ui/index.js"

export function PasteInfoHeader({ config, themeToggle }: { config: PublicEnv; themeToggle: ReactNode }) {
  return (
    <div className="mx-4 lg:mx-0 lg:px-4">
      <div className="mt-8 mb-4 flex items-center justify-between">
        <h1 className="text-3xl">{config.INDEX_PAGE_TITLE}</h1>
        {themeToggle}
      </div>
      <p className="my-2">A pastebin running on Cloudflare Workers.</p>
      <p className="my-2">
        <b>Usage</b>: Paste text, drop a file, choose your mode—Upload, direct P2P, or offline QR transfer. Share via
        the generated URL <Link href={`${config.DEPLOY_URL}/doc/curl`}>curl</Link>
        {", the "}
        <Link href={`${config.DEPLOY_URL}/doc/api`}>HTTP API</Link>
        {", or as an "}
        <Link href={`${config.DEPLOY_URL}/doc/skill.md`}>AI agent skill</Link>.
      </p>
      <p className="my-2">
        <b>Notice</b>: Uploaded pastes are meant for short-term sharing <b>(max {getMaxExpirationReadable(config)})</b>{" "}
        and may be purged without notice. Use P2P or QR transfer for direct, serverless sharing.
      </p>
    </div>
  )
}

interface TransferActionBarProps {
  activeTransfer?: "p2p" | "optical"
  selectedTransfer: "upload" | "p2p" | "optical"
  isPending: boolean
  updateDisabled: boolean
  startDisabled: boolean
  newUploadDisabled: boolean
  manageMode: boolean
  deleteDisabled: boolean
  onUpdate: () => void
  onStop: () => void
  onStart: () => void
  onNewUpload: () => void
  onDelete: () => void
}

export function TransferActionBar({
  activeTransfer,
  selectedTransfer,
  isPending,
  updateDisabled,
  startDisabled,
  newUploadDisabled,
  manageMode,
  deleteDisabled,
  onUpdate,
  onStop,
  onStart,
  onNewUpload,
  onDelete,
}: TransferActionBarProps) {
  const baseClass = "flex-1 py-3 text-center font-bold transition-colors"
  const primaryClass = `${baseClass} bg-primary-50 text-primary`
  const dangerClass = `${baseClass} rounded-br-2xl bg-danger-50 text-danger`
  const updateClass = `${baseClass} rounded-bl-2xl bg-success-50 text-success ${
    updateDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-success-100"
  }`
  const startClass = `${baseClass} ${manageMode ? "rounded-bl-2xl bg-success-50 text-success" : "rounded-b-2xl bg-primary-50 text-primary"} ${
    startDisabled
      ? "cursor-not-allowed opacity-50"
      : manageMode
        ? "cursor-pointer hover:bg-success-100"
        : "cursor-pointer hover:bg-primary-100"
  }`
  const newUploadClass = `${primaryClass} ${
    newUploadDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-primary-100"
  }`
  const deleteClass = `${dangerClass} ${
    deleteDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-danger-100"
  }`

  return (
    <div className="flex items-stretch">
      {activeTransfer ? (
        <>
          <button type="button" onClick={onUpdate} disabled={updateDisabled} className={updateClass}>
            {isPending
              ? activeTransfer === "optical"
                ? "Updating QR stream..."
                : "Updating P2P..."
              : activeTransfer === "optical"
                ? "Update QR stream"
                : "Update P2P"}
          </button>
          <button type="button" onClick={onStop} className={`${dangerClass} cursor-pointer hover:bg-danger-100`}>
            {activeTransfer === "optical" ? "Stop QR stream" : "Stop P2P"}
          </button>
        </>
      ) : (
        <button type="button" onClick={onStart} disabled={startDisabled} className={startClass}>
          {selectedTransfer === "optical"
            ? "Start QR stream"
            : selectedTransfer === "p2p"
              ? "Start P2P"
              : manageMode
                ? "Update"
                : "Start"}
        </button>
      )}
      {manageMode && (
        <>
          <button type="button" onClick={onNewUpload} disabled={newUploadDisabled} className={newUploadClass}>
            New
          </button>
          <button type="button" onClick={onDelete} disabled={deleteDisabled} className={deleteClass}>
            Delete
          </button>
        </>
      )}
    </div>
  )
}

export function PasteWorkspace({
  editor,
  panels,
  sidebar,
}: {
  editor: ReactNode
  panels: ReactNode
  sidebar: ReactNode
}) {
  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="min-w-0 flex-1">
        {editor}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">{panels}</div>
      </div>
      {sidebar}
    </div>
  )
}

export function PasteFooter({ config }: { config: PublicEnv }) {
  return (
    <footer className="my-4 px-3 text-center">
      <Link href={`${config.DEPLOY_URL}/doc/tos`}>Terms & Conditions</Link>
      {" / "}
      <Link href={config.REPO}>Repository</Link>
    </footer>
  )
}
