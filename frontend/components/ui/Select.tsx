import React, { useRef, useImperativeHandle } from "react"
import { FieldLabel, fieldControlSizeClass, ListboxOption, ListboxPopover, type FieldSize } from "./FieldPrimitives.js"

import { useListboxNavigation } from "./useListboxNavigation.js"

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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const focusFromMouseRef = useRef(false)

  useImperativeHandle(forwardedRef, () => ({
    focus() {
      triggerRef.current?.focus()
    },
  }))

  const items = React.Children.toArray(children).filter((child): child is React.ReactElement<SelectItemProps> =>
    React.isValidElement(child),
  )

  const getItemValue = (item: React.ReactElement<SelectItemProps>) =>
    item.props.value ?? String(item.key).replace(/^\.\$/, "")

  const selectedIndex = items.findIndex((item) => selectedKeys.includes(getItemValue(item)))
  const openFocusKey = items.length ? getItemValue(items[Math.max(0, selectedIndex)]) : null
  const navigation = useListboxNavigation(items.map(getItemValue), (key) => onSelectionChange?.(new Set([key])))
  const { isOpen, setIsOpen, focusedKey, setFocusedKey, containerRef, listRef } = navigation

  const selected = items[selectedIndex]
  const displayText = selected?.props.children || label || "Select..."

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault()
        setIsOpen(true)
        setFocusedKey(openFocusKey)
      }
      return
    }

    navigation.onKeyDown(e)
  }

  return (
    <div ref={containerRef} className={`relative ${classNames.base || ""} ${className || ""}`} {...rest}>
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
            setFocusedKey(openFocusKey)
          }
          focusFromMouseRef.current = false
        }}
        onBlur={navigation.onBlur}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`w-full px-3 bg-default-100 border rounded-xl text-left transition-colors focus:outline-none ${fieldControlSizeClass[size]} ${isOpen ? "border-default-400" : "border-default-200 hover:border-default-400"} ${classNames.trigger || ""}`}
      >
        {displayText}
      </button>
      {isOpen && (
        <ListboxPopover ref={listRef} className={`right-0 left-0 ${classNames.listbox || ""}`}>
          {items.map((item) => {
            const itemValue = getItemValue(item)
            return (
              <ListboxOption
                key={itemValue}
                value={itemValue}
                focused={itemValue === focusedKey}
                size={size}
                onSelect={navigation.select}
                className="whitespace-nowrap"
              >
                {item.props.children}
              </ListboxOption>
            )
          })}
        </ListboxPopover>
      )}
    </div>
  )
})
