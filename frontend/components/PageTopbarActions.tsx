import type { ReactNode } from "react"
import { QrCodeTooltip } from "./QrCodeTooltip.js"
import { WebShareButton } from "./WebShareButton.js"
import { Tooltip, iconControlClassName } from "./ui/index.js"

export function PageTopbarActions({ title, url, themeToggle }: { title: string; url: string; themeToggle: ReactNode }) {
  return (
    <>
      {themeToggle}
      {url && <QrCodeTooltip value={url} placement="bottom" className={iconControlClassName} tooltip="Show QR code" />}
      <Tooltip content="Share this page" placement="bottom">
        <WebShareButton title={title} url={url} className={iconControlClassName} plain />
      </Tooltip>
    </>
  )
}
