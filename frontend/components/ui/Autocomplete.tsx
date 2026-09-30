import React, { useState, useRef, useEffect } from "react"
import {
  FieldLabel,
  fieldControlSizeClass,
  InputClearButton,
  ListboxOption,
  ListboxPopover,
  type FieldSize,
} from "./FieldPrimitives.js"

import { useListboxNavigation } from "./useListboxNavigation.js"

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
  const [internalValue, setInternalValue] = useState(selectedKey != null ? selectedKey : inputValue)
  const inputRef = useRef<HTMLInputElement>(null)

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
  const navigation = useListboxNavigation(
    filtered.map((item) => item.key),
    (key) => {
      onSelectionChange?.(key)
      setInternalValue(key)
      onInputChange?.(key)
    },
  )
  const { isOpen, setIsOpen, focusedKey, setFocusedKey, containerRef, listRef } = navigation

  const defaultFocusKey = (list: { key: string }[]) => {
    if (list.length === 0) return null
    const inList = selectedKey && list.some((item) => item.key === selectedKey)
    return inList ? selectedKey : list[0].key
  }

  return (
    <div ref={containerRef} className={`relative ${classNames.base || ""} ${className || ""}`}>
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
          onKeyDown={navigation.onKeyDown}
          onFocus={() => {
            setIsOpen(true)
            setFocusedKey(defaultFocusKey(filtered))
          }}
          onBlur={navigation.onBlur}
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
              <ListboxOption
                key={item.key}
                value={item.key}
                focused={item.key === focusedKey}
                size={size}
                onSelect={navigation.select}
              >
                {element.props.children}
              </ListboxOption>
            )
          })}
        </ListboxPopover>
      )}
    </div>
  )
}
