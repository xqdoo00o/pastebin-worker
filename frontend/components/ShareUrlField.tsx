import type { ReactNode } from "react"
import { CopyWidget } from "./CopyWidget.js"
import { QrCodeTooltip } from "./QrCodeTooltip.js"
import { Input } from "./ui/index.js"

interface ShareUrlFieldProps {
  label: string
  value: string
  labelExtra?: ReactNode
  color?: "default" | "success"
  className?: string
  copyClassName?: string
  qrClassName?: string
}

/** Read-only share URL with the QR and copy actions used by every sender panel. */
export function ShareUrlField({
  label,
  value,
  labelExtra,
  color,
  className = "mb-2",
  copyClassName = "hover:bg-default-200",
  qrClassName = "hover:bg-default-200",
}: ShareUrlFieldProps) {
  return (
    <div className={`${className} flex items-end gap-2`}>
      <Input
        readOnly
        className="flex-1"
        label={label}
        labelExtra={labelExtra}
        color={color}
        value={value}
        endContent={<QrCodeTooltip value={value} className={qrClassName} />}
      />
      <CopyWidget
        label="Copy link"
        className={`h-[38px] bg-default-100 transition-colors ${copyClassName}`}
        getCopyContent={() => value}
      />
    </div>
  )
}
