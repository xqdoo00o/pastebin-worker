import type { ReactNode } from "react"
import { Tooltip } from "./ui/index.js"

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
}

interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  options: readonly SegmentedOption<T>[]
  value: T | undefined
  onChange: (value: T) => void
  className?: string
  buttonClassName?: string
  disabled?: boolean
  tooltipContent?: (option: SegmentedOption<T>) => ReactNode
}

/** Accessible, consistently styled radio-like button group used by compact
 * settings selectors. */
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
  className = "",
  buttonClassName = "px-4",
  disabled = false,
  tooltipContent,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`grid h-9 min-w-0 rounded-lg border border-default-300 bg-content1 ${className}`}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const selected = value === option.value
        const button = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={
              `h-full w-full min-w-0 whitespace-nowrap text-sm transition-colors ${buttonClassName} ` +
              (index === 0 ? "rounded-l-lg " : "border-l border-default-300 ") +
              (index === options.length - 1 ? "rounded-r-lg " : "") +
              (disabled ? "cursor-not-allowed opacity-60 " : "cursor-pointer ") +
              (selected
                ? "bg-primary-50 font-medium text-primary"
                : disabled
                  ? "text-default-600"
                  : "text-default-600 hover:bg-default-100")
            }
          >
            {option.label}
          </button>
        )
        const tooltip = tooltipContent?.(option) ?? option.description
        return tooltip ? (
          <Tooltip key={option.value} content={tooltip}>
            {button}
          </Tooltip>
        ) : (
          button
        )
      })}
    </div>
  )
}
