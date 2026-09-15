import { forwardRef, useMemo } from "react"
import type { ComponentPropsWithoutRef } from "react"
import { countTextLines, lineNumberText } from "../../shared/format.js"

interface LineNumbersProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  lineCount: number
}

export function lineNumberOffset(lineCount: number): string {
  const count = Math.max(1, Math.floor(lineCount))
  return `${Math.floor(Math.log10(count)) + 3}ch`
}

export { countTextLines }

export const LineNumbers = forwardRef<HTMLDivElement, LineNumbersProps>(
  ({ lineCount, className = "", ...props }, ref) => {
    const content = useMemo(() => lineNumberText(lineCount), [lineCount])
    return (
      <div ref={ref} aria-hidden="true" className={`line-number-rows m-0 ${className}`} {...props}>
        {content}
      </div>
    )
  },
)

LineNumbers.displayName = "LineNumbers"
