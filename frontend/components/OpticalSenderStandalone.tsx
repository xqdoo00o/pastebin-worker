import { useCallback, useRef, useState } from "react"
import type { PublicEnv } from "../../shared/interfaces.js"
import type { OpticalTransferSettings } from "../optical/shared/settings.js"
import { loadOpticalSenderSettings, saveOpticalSenderSettings } from "../optical/shared/settings.js"
import { defaultOpticalTransferSettings } from "../utils/pasteSetting.js"
import { Button, PageContainer, PageShell, PanelCard } from "./ui/index.js"
import { OpticalFileStream } from "./QrCameraStream.js"
import { OpticalSettingsFields } from "./OpticalSettingsFields.js"
import { useErrorModal } from "./ErrorModal.js"

export function OpticalSenderStandalone({ config }: { config: PublicEnv }) {
  const [file, setFile] = useState<File>()
  const [settings, setSettings] = useState<OpticalTransferSettings>(() =>
    loadOpticalSenderSettings(defaultOpticalTransferSettings(config)),
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { errorModal, handleError } = useErrorModal()
  const handleOpticalError = useCallback((error: Error) => handleError("Error on QR Transfer", error), [handleError])

  const onSettingsChange = useCallback((next: OpticalTransferSettings) => {
    setSettings(next)
    saveOpticalSenderSettings(next)
  }, [])

  return (
    <PageShell>
      <PageContainer className="max-w-[64rem] px-4 pt-6 pb-8">
        <PanelCard title="QR Transfer">
          <OpticalSettingsFields
            settings={settings}
            onSettingsChange={onSettingsChange}
            className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
          />

          {file ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-default-500">{file.name}</span>
                <Button
                  size="sm"
                  variant="light"
                  className="h-[38px] cursor-pointer whitespace-nowrap bg-default-100 px-3 transition-colors hover:bg-default-200"
                  onPress={() => fileInputRef.current?.click()}
                >
                  Change file
                </Button>
              </div>
              <OpticalFileStream file={file} settings={settings} onError={handleOpticalError} />
            </>
          ) : (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-default-300">
              <p className="text-sm text-default-500">Choose a file or text to stream as a QR camera sequence.</p>
              <Button onPress={() => fileInputRef.current?.click()}>Choose file</Button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              setFile(event.target.files?.[0])
              event.target.value = ""
            }}
          />
        </PanelCard>
        {errorModal}
      </PageContainer>
    </PageShell>
  )
}
