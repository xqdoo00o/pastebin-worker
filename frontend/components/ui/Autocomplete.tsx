import React, { useState, useRef, useEffect } from "react"
import {
  FieldLabel,
  fieldControlSizeClass,
  InputClearButton,
  ListboxPopover,
  type FieldSize,
} from "./FieldPrimitives.js"

export interface AutocompleteItemProps {
  value: string
  children: string
}

export function AutocompleteItem({ children }: AutocompleteItemProps) {
  return <>{children}</>
}

export interface AutocompleteProps {
  label?: string
  size?: FieldSize
  inputValue?: string
  selectedKey?: string | null
  defaultItems?: { key: string }[]
  onInputChange?: (value: string) => void
  onSelectionChange?: (key: string | null) => void
  className?: string
  classNames?: {
    base?: string
    input?: string
    listbox?: string
  }
  children: (item: { key: string }) => React.ReactElement<AutocompleteItemProps>
  placeholder?: string
  readOnly?: boolean
  isClearable?: boolean
}

export function Autocomplete({
  label,
  size = "md",
  inputValue = "",
  selectedKey,
  defaultItems = [],
  onInputChange,
  onSelectionChange,
  className,
  classNames = {},
  children,
  placeholder,
  readOnly,
  isClearable,
}: AutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [internalValue, setInternalValue] = useState(selectedKey != null ? selectedKey : inputValue)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusedKey === null || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedKey)}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [focusedKey])

  useEffect(() => {
    setInternalValue(selectedKey != null ? selectedKey : inputValue)
  }, [selectedKey, inputValue])

  const filterItems = (items: { key: string }[], value: string) => {
    const lower = value.toLowerCase()
    return items.filter((item) =>
      lower.length <= 2 ? item.key.toLowerCase().startsWith(lower) : item.key.toLowerCase().includes(lower),
    )
  }

  const filtered = filterItems(defaultItems, internalValue)

  const defaultFocusKey = (list: { key: string }[]) => {
    if (list.length === 0) return null
    const inList = selectedKey && list.some((item) => item.key === selectedKey)
    return inList ? selectedKey : list[0].key
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) return

    const focusedIndex = focusedKey !== null ? filtered.findIndex((item) => item.key === focusedKey) : -1

    if (e.key === "ArrowDown") {
      e.preventDefault()
      const next = focusedIndex < filtered.length - 1 ? focusedIndex + 1 : focusedIndex
      if (next >= 0) setFocusedKey(filtered[next].key)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const prev = focusedIndex > 0 ? focusedIndex - 1 : 0
      if (prev >= 0) setFocusedKey(filtered[prev].key)
    } else if (e.key === "Enter" && focusedIndex >= 0) {
      e.preventDefault()
      const item = filtered[focusedIndex]
      onSelectionChange?.(item.key)
      setInternalValue(item.key)
      onInputChange?.(item.key)
      setIsOpen(false)
      setFocusedKey(null)
    } else if (e.key === "Escape") {
      setIsOpen(false)
      setFocusedKey(null)
    }
  }

  return (
    <div ref={ref} className={`relative ${classNames.base || ""} ${className || ""}`}>
      {label && <FieldLabel className="mb-1.5 block">{label}</FieldLabel>}
      <div
        className={`flex items-center rounded-xl border bg-default-100 transition-colors ${isOpen ? "border-default-400" : "border-default-200 hover:border-default-400"}`}
      >
        <input
          ref={inputRef}
          type="text"
          value={internalValue}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => {
            const val = e.target.value
            setInternalValue(val)
            onInputChange?.(val)
            setIsOpen(true)
            const newFiltered = filterItems(defaultItems, val)
            setFocusedKey((prev) => {
              if (prev !== null && newFiltered.some((item) => item.key === prev)) return prev
              return defaultFocusKey(newFiltered)
            })
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setIsOpen(true)
            setFocusedKey(defaultFocusKey(filtered))
          }}
          onBlur={(e) => {
            if (!ref.current?.contains(e.relatedTarget)) {
              setIsOpen(false)
              setFocusedKey(null)
            }
          }}
          className={`flex-1 min-w-0 px-3 bg-transparent text-foreground focus:outline-none ${fieldControlSizeClass[size]} ${classNames.input || ""}`}
        />
        {isClearable && internalValue !== "" && (
          <InputClearButton
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setInternalValue("")
              onInputChange?.("")
              onSelectionChange?.(null)
              inputRef.current?.focus()
            }}
            className="px-2"
          />
        )}
      </div>
      {isOpen && filtered.length > 0 && (
        <ListboxPopover ref={listRef} className={`w-full ${classNames.listbox || ""}`}>
          {filtered.map((item) => {
            const element = children(item)
            return (
              <button
                key={item.key}
                data-key={item.key}
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelectionChange?.(item.key)
                  setInternalValue(item.key)
                  onInputChange?.(item.key)
                  setIsOpen(false)
                  setFocusedKey(null)
                }}
                className={`w-full px-3 text-left transition-colors ${fieldControlSizeClass[size]} ${item.key === focusedKey ? "bg-default-100" : "hover:bg-default-100"}`}
              >
                {element.props.children as React.ReactNode}
              </button>
            )
          })}
        </ListboxPopover>
      )}
    </div>
  )
}
