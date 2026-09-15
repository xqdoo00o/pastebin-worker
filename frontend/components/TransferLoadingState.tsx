import type { ReactNode } from "react"
import { Button, CircularProgress, PanelLoadingState } from "./ui/index.js"

interface TransferLoadingStateProps {
  progressLabel: string
  progressValue?: number
  children?: ReactNode
  onCancel?: () => void
}

/** Consistent pending state shared by upload and peer-to-peer transfer panels. */
export function TransferLoadingState({ progressLabel, progressValue, children, onCancel }: TransferLoadingStateProps) {
  return (
    <PanelLoadingState>
      <CircularProgress aria-label={progressLabel} value={progressValue} />
      {children}
      {onCancel && (
        <Button size="sm" variant="ghost" onPress={onCancel} className="mt-1">
          Cancel
        </Button>
      )}
    </PanelLoadingState>
  )
}
