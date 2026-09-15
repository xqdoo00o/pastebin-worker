import { forwardRef, type ButtonHTMLAttributes, type LabelHTMLAttributes, type ReactNode } from "react"
import { XIcon } from "../icons.js"

export type FieldSize = "sm" | "md" | "lg"

export const fieldControlSizeClass: Record<FieldSize, string> = {
  sm: "py-1.5 text-sm",
  md: "py-2 text-sm",
  lg: "py-3 text-base",
}

export function FieldLabel({ className = "", ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={`pl-1 text-sm text-default-500 ${className}`} {...props} />
}

interface ListboxPopoverProps {
  children: ReactNode
  className?: string
  viewportClassName?: string
}

export const ListboxPopover = forwardRef<HTMLDivElement, ListboxPopoverProps>(
  ({ children, className = "", viewportClassName = "" }, ref) => (
    <div
      className={`absolute z-10 mt-1 overflow-hidden rounded-lg border border-default-200 bg-content1 shadow-medium ${className}`}
    >
      <div ref={ref} tabIndex={-1} className={`max-h-60 overflow-auto ${viewportClassName}`}>
        {children}
      </div>
    </div>
  ),
)

ListboxPopover.displayName = "ListboxPopover"

export function InputClearButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={`flex-shrink-0 text-default-400 transition-colors hover:text-default-700 focus:outline-none ${className}`}
      aria-label="Clear input"
      {...props}
    >
      <XIcon className="h-4 w-4" />
    </button>
  )
}
