import type { CardProps } from "./ui/index.js"
import { PanelCard } from "./ui/index.js"
import { OpticalFileStream } from "./QrCameraStream.js"
import { InfoTooltip } from "./InfoTooltip.js"
import type { OpticalTransferSettings } from "../optical/shared/settings.js"
import { ShareUrlField } from "./ShareUrlField.js"

interface OpticalTransferPanelProps extends CardProps {
  file: File
  highlightLanguage?: string
  settings: OpticalTransferSettings
  receiverUrl: string
  onTransferError?: (error: Error) => void
}

export function OpticalTransferPanel({
  file,
  highlightLanguage,
  settings,
  receiverUrl,
  onTransferError,
  className,
  ...rest
}: OpticalTransferPanelProps) {
  return (
    <PanelCard title="QR Transfer" className={className} {...rest}>
      <ShareUrlField
        className="mb-3"
        label="Receiver URL"
        labelExtra={
          <InfoTooltip compact label="More information about the receiver URL">
            Open this URL on the receiver. Supports live camera scanning, screen capture, or APNG file import.
          </InfoTooltip>
        }
        value={receiverUrl}
      />
      <OpticalFileStream
        file={file}
        highlightLanguage={highlightLanguage}
        settings={settings}
        onError={onTransferError}
      />
    </PanelCard>
  )
}
