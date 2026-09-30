import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react"

/** Shared focus and keyboard behavior; filtering and selection values belong to the field. */
export function useListboxNavigation(keys: readonly string[], onSelect: (key: string) => void) {
  const [isOpen, setIsOpen] = useState(false)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen || focusedKey === null) return
    const element = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedKey)}"]`)
    element?.scrollIntoView({ block: "nearest" })
  }, [isOpen, focusedKey])

  const close = () => {
    setIsOpen(false)
    setFocusedKey(null)
  }

  const select = (key: string) => {
    onSelect(key)
    close()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isOpen) return
    const index = focusedKey === null ? -1 : keys.indexOf(focusedKey)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next = event.key === "ArrowDown" ? Math.min(index + 1, keys.length - 1) : Math.max(0, index - 1)
      setFocusedKey(keys[next] ?? null)
    } else if (event.key === "Enter" && index >= 0) {
      event.preventDefault()
      select(keys[index])
    } else if (event.key === "Escape") {
      close()
    }
  }

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!containerRef.current?.contains(event.relatedTarget)) close()
  }

  return { isOpen, setIsOpen, focusedKey, setFocusedKey, containerRef, listRef, select, close, onKeyDown, onBlur }
}
