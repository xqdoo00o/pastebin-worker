import React from "react"

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  isSelected?: boolean
  onValueChange?: (checked: boolean) => void
  classNames?: {
    base?: string
    wrapper?: string
  }
}

export function Switch({
  isSelected,
  onValueChange,
  children,
  classNames = {},
  className = "",
  disabled,
  ...rest
}: SwitchProps) {
  const checked = isSelected ?? false

  return (
    <label
      className={`inline-flex items-center gap-2 ${disabled ? "cursor-not-allowed" : "cursor-pointer"} ${className} ${classNames.base || ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onValueChange?.(e.target.checked)}
        className="peer sr-only"
        {...rest}
      />
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 shrink-0 rounded-full bg-gray-200 transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-default-400 dark:bg-gray-700 ${classNames.wrapper || ""}`}
      />
      {children}
    </label>
  )
}
