import { useEffect, useState } from "react"
import type { OpticalTransferSettings } from "../optical/shared/settings.js"
import { Button, CircularProgress, Input, NativeSelectField, PanelLoadingState, StatusBanner } from "./ui/index.js"
import { DownloadIcon, XIcon } from "./icons.js"
import { InfoTooltip } from "./InfoTooltip.js"
import { APNG_QR_SCALE_OPTIONS, DEFAULT_EXPORT_EXTRA_PERCENT, defaultQrScale } from "../optical/shared/fountain.js"
import type { ApngQrScale } from "../optical/shared/fountain.js"
import { useOpticalStream, type OpticalApngExportController } from "../utils/optical/useOpticalStream.js"

export type OpticalStream = ReturnType<typeof useOpticalStream>

interface QrCameraStreamProps {
  stream: OpticalStream
  settings: OpticalTransferSettings
}

interface OpticalFileStreamProps {
  file: File
  highlightLanguage?: string
  settings: OpticalTransferSettings
  onError?: (error: Error) => void
}

/** Prepare and render one selected file as a live optical stream. */
export function OpticalFileStream({ file, highlightLanguage, settings, onError }: OpticalFileStreamProps) {
  const stream = useOpticalStream({ file, highlightLanguage, settings, onError })
  return <QrCameraStream stream={stream} settings={settings} />
}

/** Manual segment navigation for multi-part transfers: 上一段 / jump input /
 * 下一段 on one line above the QR stream. */
/** Border + hover background + pointer cursor for the segment nav buttons.
 * Disabled buttons keep their flat look on hover. h-[38px] lines the buttons
 * up with the segment input box; px-4 widens the horizontal padding. */
const NAV_BUTTON_CLASS =
  "cursor-pointer h-[38px] border border-default-300 px-5 hover:bg-default-200 disabled:hover:bg-transparent"

function SegmentNavBar({ stream }: { stream: OpticalStream }) {
  const [text, setText] = useState(String(stream.currentPart + 1))
  // Keep the field in step with part changes driven by the buttons or a jump.
  useEffect(() => setText(String(stream.currentPart + 1)), [stream.currentPart])
  const partCount = stream.partCount

  const jump = () => {
    const target = Math.round(Number(text)) - 1
    if (!Number.isFinite(target) || target < 0 || target >= partCount) return
    stream.switchPart(target)
  }

  return (
    <div className="mb-3 flex items-center justify-center gap-2 overflow-x-auto whitespace-nowrap rounded-xl bg-default-100 px-3 py-2 text-sm text-foreground">
      <Button
        size="sm"
        variant="light"
        className={NAV_BUTTON_CLASS}
        isDisabled={stream.currentPart === 0}
        onPress={() => stream.switchPart(stream.currentPart - 1)}
      >
        上一段
      </Button>
      <span className="flex items-center gap-1">
        <Input
          type="number"
          min={1}
          max={partCount}
          aria-label="跳转到第几段"
          className="w-20"
          value={text}
          onValueChange={setText}
          onKeyDown={(event) => {
            if (event.key === "Enter") jump()
          }}
        />
        <span className="text-default-500">/{partCount}</span>
      </span>
      <Button size="sm" variant="light" className={NAV_BUTTON_CLASS} onPress={jump}>
        跳转
      </Button>
      <Button
        size="sm"
        variant="light"
        className={NAV_BUTTON_CLASS}
        isDisabled={stream.currentPart === partCount - 1}
        onPress={() => stream.switchPart(stream.currentPart + 1)}
      >
        下一段
      </Button>
    </div>
  )
}

/** Normalize the free-form APNG extra-symbol input to the supported range. */
function normalizeExtraPercent(text: string): number | undefined {
  if (text.trim() === "") return undefined
  const value = Math.round(Number(text))
  return Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : undefined
}

function ApngExportControls({
  settings,
  apng,
  disabled,
}: {
  settings: OpticalTransferSettings
  apng: OpticalApngExportController
  disabled: boolean
}) {
  const [extraPercentText, setExtraPercentText] = useState(String(DEFAULT_EXPORT_EXTRA_PERCENT))
  const extraPercent = normalizeExtraPercent(extraPercentText) ?? DEFAULT_EXPORT_EXTRA_PERCENT
  const [qrScale, setQrScale] = useState<ApngQrScale>(() => defaultQrScale(settings.gridCodes) as ApngQrScale)
  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="light"
          className="h-[38px] cursor-pointer gap-1.5 whitespace-nowrap bg-default-100 px-2 transition-colors hover:bg-default-200"
          onPress={apng.isExporting ? apng.cancel : () => apng.start(extraPercent, qrScale)}
          isDisabled={!apng.isExporting && disabled}
        >
          {apng.isExporting ? (
            <XIcon className="size-6 text-default-600" />
          ) : (
            <DownloadIcon className="size-6 text-default-600" />
          )}
          {apng.isExporting ? "Cancel export" : "Export APNG"}
        </Button>
        <span className="text-sm text-default-500">with extra</span>
        <Input
          type="number"
          min={1}
          max={100}
          aria-label="APNG extra symbols percent"
          className="w-20"
          value={extraPercentText}
          endContent={<span className="pr-2 text-sm text-default-500">%</span>}
          onValueChange={(text) => {
            const normalized = normalizeExtraPercent(text)
            setExtraPercentText(normalized === undefined ? text : String(normalized))
          }}
          onBlur={() => {
            if (extraPercentText.trim() === "") setExtraPercentText(String(DEFAULT_EXPORT_EXTRA_PERCENT))
          }}
          disabled={apng.isExporting}
        />
        <span className="-ml-1.5">
          <InfoTooltip compact label="More information about APNG extra symbols">
            Fountain code redundancy (beyond minimum K). Higher redundancy increases file size but improves recovery
            from missed frames.
          </InfoTooltip>
        </span>
        <NativeSelectField
          label="APNG export scale"
          labelClassName="sr-only"
          wrapperClassName="shrink-0"
          aria-label="APNG export scale"
          value={qrScale}
          onChange={(event) => setQrScale(Number(event.target.value) as ApngQrScale)}
          variant="compact"
          disabled={apng.isExporting}
        >
          {APNG_QR_SCALE_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value}x
            </option>
          ))}
        </NativeSelectField>
        <span className="-ml-1.5">
          <InfoTooltip compact label="More information about APNG export scale">
            Module size per QR block. Larger modules scan more reliably, but result in bigger APNG files.
          </InfoTooltip>
        </span>
      </div>
      {apng.progress && (
        <div className="mt-3" aria-live="polite">
          <div className="mb-1 flex justify-between text-xs text-default-500">
            <span>Encoding one complete QR carousel…</span>
            <span>{apng.percent}%</span>
          </div>
          <progress
            aria-label="APNG export progress"
            className="h-2 w-full accent-primary"
            value={apng.progress.completed}
            max={apng.progress.total || 1}
          />
        </div>
      )}
      {apng.status && !apng.isExporting && (
        <p className="mt-3 text-xs text-default-500" role="status">
          {apng.status}
        </p>
      )}
      {apng.error && (
        <StatusBanner role="alert" tone="danger" className="mt-3">
          APNG export failed: {apng.error}
        </StatusBanner>
      )}
    </>
  )
}

/**
 * Renders the live QR camera stream and its APNG export controls: preparation/
 * error status, animated code canvas with fullscreen zoom, and transfer info.
 * Shared by the full transfer panel and standalone sender page.
 */
function QrCameraStream({ stream, settings }: QrCameraStreamProps) {
  const zstdSavingsPercent =
    stream.preparedFile?.compression === "zstd" && stream.preparedFile.originalSize > 0
      ? Math.max(0, Math.min(100, (1 - stream.preparedFile.transmittedSize / stream.preparedFile.originalSize) * 100))
      : undefined
  const zstdStatus = stream.preparedFile?.compression === "zstd" ? "on" : "off"

  if (!stream.preparedFile) {
    return stream.error ? (
      <StatusBanner role="alert" tone="danger">
        {stream.error}
      </StatusBanner>
    ) : (
      <PanelLoadingState className="min-h-48">
        <CircularProgress aria-label="Preparing QR camera stream" />
        <span className="text-sm text-default-500">Preparing QR camera stream...</span>
      </PanelLoadingState>
    )
  }

  return (
    <>
      {stream.error ? (
        <StatusBanner role="alert" tone="danger" className="mb-3">
          {stream.error}
        </StatusBanner>
      ) : (
        <StatusBanner className="mb-3">{stream.status}</StatusBanner>
      )}
      {stream.partCount > 1 && <SegmentNavBar stream={stream} />}
      <div
        ref={stream.stageRef}
        hidden={stream.error !== undefined}
        className={
          stream.isFullscreen
            ? "fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-content1"
            : `flex w-full min-w-0 max-w-full justify-center overflow-hidden rounded-xl p-2 ${
                stream.streamReady ? "cursor-zoom-in" : "cursor-default"
              }`
        }
        onClick={() => {
          if (stream.streamReady || stream.isFullscreen) stream.setIsFullscreen((current) => !current)
        }}
      >
        {!stream.streamReady && (
          <PanelLoadingState className="min-h-48">
            <CircularProgress aria-label="Generating first QR frame" />
            <span className="text-sm text-default-500">Generating first QR frame...</span>
          </PanelLoadingState>
        )}
        <canvas
          ref={stream.canvasRef}
          hidden={!stream.streamReady || stream.rendererBackend !== "webgl2"}
          aria-label={stream.rendererBackend === "webgl2" ? "Animated multi-code QR data stream" : undefined}
        />
        <canvas
          ref={stream.fallbackCanvasRef}
          hidden={!stream.streamReady || stream.rendererBackend !== "2d"}
          aria-label={stream.rendererBackend === "2d" ? "Animated multi-code QR data stream" : undefined}
        />
      </div>
      {!stream.error && stream.streamInfo && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-default-500 sm:grid-cols-4">
          <span>
            {settings.txFps} fps × {settings.gridCodes}
          </span>
          <span>
            zstd {zstdStatus}
            {zstdSavingsPercent !== undefined && ` · -${zstdSavingsPercent.toFixed(1)}%`}
          </span>
          <span>{settings.frameBytes} B/Frame</span>
          <span>
            QR V{stream.streamInfo.version} · ECC {settings.ecc}
          </span>
        </div>
      )}
      <ApngExportControls settings={settings} apng={stream.apng} disabled={stream.error !== undefined} />
    </>
  )
}
