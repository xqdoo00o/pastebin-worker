import { useCallback, useEffect, useRef, useState } from "react"

export type ClipboardCopyStatus = "idle" | "copied" | "failed"

export function useClipboardCopy(resetAfterMs = 1500) {
  const [status, setStatus] = useState<ClipboardCopyStatus>("idle")
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
    },
    [],
  )

  const copy = useCallback(
    async (content: string): Promise<void> => {
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current)
      try {
        await navigator.clipboard.writeText(content)
        setStatus("copied")
      } catch {
        setStatus("failed")
      }
      resetTimer.current = setTimeout(() => setStatus("idle"), resetAfterMs)
    },
    [resetAfterMs],
  )

  return { status, copy }
}
