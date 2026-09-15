import type { ButtonHTMLAttributes } from "react"

import { ActionButton, Button } from "./ui/index.js"
import { CopyIcon, CheckIcon } from "./icons.js"
import { useClipboardCopy } from "../utils/useClipboardCopy.js"

interface CopyWidgetProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color" | "onClick"> {
  getCopyContent: () => string
  label?: string
  appearance?: "button" | "action"
  copiedLabel?: string
  failedLabel?: string
}

export function CopyWidget({
  className = "",
  getCopyContent,
  label,
  appearance = "button",
  copiedLabel = "Copied!",
  failedLabel = "Copy failed",
  ...rest
}: CopyWidgetProps) {
  const { status, copy } = useClipboardCopy(1000)
  const copied = status === "copied"
  const content = (
    <>
      {copied ? <CheckIcon className="size-6 text-default-600" /> : <CopyIcon className="size-6 text-default-600" />}
      {label && <span>{copied ? copiedLabel : status === "failed" ? failedLabel : label}</span>}
    </>
  )
  const sharedProps = {
    type: "button" as const,
    "aria-label": label || "Copy",
    onClick: () => void copy(getCopyContent()),
    ...rest,
  }

  if (appearance === "action") {
    return (
      <ActionButton variant="tertiary" className={`gap-2 ${className}`} {...sharedProps}>
        {content}
      </ActionButton>
    )
  }

  return (
    <Button
      isIconOnly={label === undefined}
      size="sm"
      variant="light"
      className={`cursor-pointer ${label ? "gap-1.5 whitespace-nowrap" : ""} ${className}`}
      {...sharedProps}
    >
      {content}
    </Button>
  )
}
