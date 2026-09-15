import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from "react"

import { ShareIcon } from "./icons.js"
import { ActionButton } from "./ui/index.js"
import { isFileShareAllowedByBrowser, shouldShareTextAsFile } from "../utils/webShare.js"
import { isAbortError } from "../utils/errors.js"

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

type WebShareButtonProps = {
  title: string
  text?: string
  file?: File
  url?: string
  className?: string
  plain?: boolean
} & Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onMouseEnter" | "onMouseLeave" | "onFocus" | "onBlur" | "aria-describedby"
>

/** Shares preview content when the browser exposes the Web Share API. */
export function WebShareButton({
  title,
  text,
  file,
  url,
  className = "",
  plain = false,
  ...triggerProps
}: WebShareButtonProps) {
  const [status, setStatus] = useState<"idle" | "failed">("idle")
  const [isShareable, setIsShareable] = useState(false)
  const shareDataRef = useRef<ShareData | undefined>(undefined)
  const sharedFile = file && (text === undefined || shouldShareTextAsFile(text)) ? file : undefined

  // Keep the server and initial client markup identical, then complete the
  // synchronous capability check before the browser's first paint.
  useBrowserLayoutEffect(() => {
    shareDataRef.current = undefined
    if (typeof navigator.share !== "function") {
      setIsShareable(false)
      return
    }

    const baseData: ShareData = { title }
    if (text !== undefined && !sharedFile) baseData.text = text
    if (url !== undefined) baseData.url = new URL(url, window.location.href).href
    const data = sharedFile ? { ...baseData, files: [sharedFile] } : baseData
    const canShareFunction = Reflect.get(navigator, "canShare") as ((shareData?: ShareData) => boolean) | undefined

    try {
      if (sharedFile && !isFileShareAllowedByBrowser(sharedFile)) {
        setIsShareable(false)
        return
      }
      const canShare = typeof canShareFunction === "function" ? canShareFunction.call(navigator, data) : true
      if (canShare) shareDataRef.current = data
      setIsShareable(canShare)
    } catch {
      setIsShareable(false)
    }
  }, [sharedFile, text, title, url])

  if (!isShareable) return null

  async function share() {
    const data = shareDataRef.current
    if (!data) return
    try {
      await navigator.share(data)
      setStatus("idle")
    } catch (error) {
      if (isAbortError(error)) return
      setStatus("failed")
    }
  }

  const buttonProps = {
    ...triggerProps,
    type: "button" as const,
    "aria-label": status === "failed" ? "Share failed" : "Share",
    title: sharedFile ? "Share file" : text !== undefined ? "Share text" : undefined,
    onClick: () => void share(),
  }
  const icon = <ShareIcon className="size-6 text-default-600" aria-hidden="true" />

  return plain ? (
    <button className={className} {...buttonProps}>
      {icon}
    </button>
  ) : (
    <ActionButton isIconOnly variant="tertiary" className={className} {...buttonProps}>
      {icon}
    </ActionButton>
  )
}
