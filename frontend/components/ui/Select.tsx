import React, { useState, useRef, useEffect, useImperativeHandle } from "react"
import { FieldLabel, fieldControlSizeClass, ListboxPopover, type FieldSize } from "./FieldPrimitives.js"

export interface SelectItemProps {
  children: React.ReactNode
  value?: string
}

export function SelectItem({ children }: SelectItemProps) {
  return <>{children}</>
}

export interface SelectHandle {
  focus(): void
}

export interface SelectProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  label?: string
  size?: FieldSize
  selectedKeys?: string[]
  onSelectionChange?: (keys: Set<string>) => void
  classNames?: {
    base?: string
    trigger?: string
    listbox?: string
  }
  children: React.ReactNode
}

export const Select = React.forwardRef<SelectHandle, SelectProps>(function Select(
  { label, size = "md", selectedKeys = [], onSelectionChange, className, classNames = {}, children, ...rest },
  forwardedRef,
) {
  const [isOpen, setIsOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const innerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusFromMouseRef = useRef(false)

  useImperativeHandle(forwardedRef, () => ({
    focus() {
      triggerRef.current?.focus()
    },
  }))

  useEffect(() => {
    if (focusedIndex < 0 || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${focusedIndex}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [focusedIndex])

  const items = React.Children.toArray(children).filter((child): child is React.ReactElement<SelectItemProps> =>
    React.isValidElement(child),
  )

  const getItemValue = (item: React.ReactElement<SelectItemProps>) =>
    item.props.value ?? String(item.key).replace(/^\.\$/, "")

  const selectedIndex = items.findIndex((item) => selectedKeys.includes(getItemValue(item)))
  const openFocusIndex = selectedIndex >= 0 ? selectedIndex : 0

  const selected = items[selectedIndex]
  const displayText = selected?.props.children || label || "Select..."

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault()
        setIsOpen(true)
        setFocusedIndex(openFocusIndex)
      }
      return
    }

    if (e.key === "ArrowDown") {
      e.preventDefault()
      setFocusedIndex((prev) => (prev < items.length - 1 ? prev + 1 : prev))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setFocusedIndex((prev) => (prev > 0 ? prev - 1 : 0))
    } else if (e.key === "Enter" && focusedIndex >= 0) {
      e.preventDefault()
      onSelectionChange?.(new Set([getItemValue(items[focusedIndex])]))
      setIsOpen(false)
      setFocusedIndex(-1)
    } else if (e.key === "Escape") {
      setIsOpen(false)
      setFocusedIndex(-1)
    }
  }

  return (
    <div ref={innerRef} className={`relative ${classNames.base || ""} ${className || ""}`} {...rest}>
      {label && <FieldLabel className="mb-1.5 block">{label}</FieldLabel>}
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={() => {
          focusFromMouseRef.current = true
        }}
        onFocus={() => {
          if (!focusFromMouseRef.current) {
            setIsOpen(true)
            setFocusedIndex(openFocusIndex)
          }
          focusFromMouseRef.current = false
        }}
        onBlur={(e) => {
          if (!innerRef.current?.contains(e.relatedTarget)) {
            setIsOpen(false)
            setFocusedIndex(-1)
          }
        }}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`w-full px-3 bg-default-100 border rounded-xl text-left transition-colors focus:outline-none ${fieldControlSizeClass[size]} ${isOpen ? "border-default-400" : "border-default-200 hover:border-default-400"} ${classNames.trigger || ""}`}
      >
        {displayText}
      </button>
      {isOpen && (
        <ListboxPopover ref={listRef} className={`right-0 left-0 ${classNames.listbox || ""}`}>
          {items.map((item, index) => {
            const itemValue = getItemValue(item)
            return (
              <button
                key={itemValue}
                data-index={index}
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelectionChange?.(new Set([itemValue]))
                  setIsOpen(false)
                  setFocusedIndex(-1)
                }}
                className={`w-full px-3 text-left transition-colors whitespace-nowrap ${fieldControlSizeClass[size]} ${index === focusedIndex ? "bg-default-100" : "hover:bg-default-100"}`}
              >
                {item.props.children}
              </button>
            )
          })}
        </ListboxPopover>
      )}
    </div>
  )
})
