import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"

import { DarkModeToggle, useDarkModeSelection } from "../../components/DarkModeToggle.js"
import { QrCodeTooltip } from "../../components/QrCodeTooltip.js"
import { WebShareButton } from "../../components/WebShareButton.js"
import { HljsProvider } from "../../utils/highlight-client.js"
import { ChevronDownIcon, HomeIcon, RefreshIcon } from "../../components/icons.js"
import {
  ActionButton,
  NativeSelectField,
  PageContainer,
  PageShell,
  PageTopbar,
  Tooltip,
  actionControlClassName,
  iconControlClassName,
} from "../../components/ui/index.js"
import { desktopScreenCaptureAvailable } from "./camera.js"
import {
  createOpticalReceiverController,
  opticalDecodeWorkerLimit,
  type OpticalReceiverController,
  type OpticalReceiverElements,
} from "./receiver-controller.js"
import { OpticalReceivedFailure, OpticalReceivedFileResult } from "./result-renderer.js"
import { ActionRow } from "../../components/ReceivedPreview.js"
import {
  initialReceiverUiState,
  showMultipartActions,
  type ReceiveMode,
  type ReceiverResultState,
} from "./receiver-view.js"
import { CAPTURE_FPS_OPTIONS, CAPTURE_WIDTH_OPTIONS } from "../shared/settings.js"

import "../../style.css"
import "../../styles/received-preview.css"
import "../../styles/highlight-theme.css"
import "../../optical-receive.css"

const MODE_BUTTON_CLASS = "mode-button rounded-lg border-0 bg-transparent px-3 py-2 text-sm text-foreground"
const HELP_TEXT_CLASS = "-mt-1 text-sm text-default-500"
const TOPBAR_ICON_LINK_CLASS = iconControlClassName
const DISALLOWED_MIME_TYPES = __WRANGLER_CONFIG__.DISALLOWED_MIME_FOR_PASTE

function OpticalReceivePage() {
  const indexPageTitle = __WRANGLER_CONFIG__.INDEX_PAGE_TITLE || "Pastebin"
  const screenAvailable = desktopScreenCaptureAvailable()
  const receiverUrl = window.location.href
  const [ui, setUi] = useState(initialReceiverUiState)
  const controller = useRef<OpticalReceiverController | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const cameraBox = useRef<HTMLDivElement>(null)
  const progressBar = useRef<HTMLDivElement>(null)
  const apngInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const elements: OpticalReceiverElements = {
      video: video.current!,
      preview: preview.current!,
      cameraBox: cameraBox.current!,
      progressBar: progressBar.current!,
    }
    const mountedController = createOpticalReceiverController(elements, setUi)
    controller.current = mountedController
    return () => {
      controller.current = null
      mountedController.dispose()
    }
  }, [])

  const switchMode = (mode: ReceiveMode) => controller.current?.switchMode(mode)
  const workerLimit = opticalDecodeWorkerLimit()

  return (
    <PageShell>
      <PageContainer className="receiver-shell">
        <PageTopbar
          className="receiver-topbar"
          heading={
            <>
              <a
                className={`${TOPBAR_ICON_LINK_CLASS} receiver-home-link md:hidden`}
                href="/"
                aria-label={indexPageTitle}
              >
                <HomeIcon className="size-6" aria-hidden="true" />
              </a>
              <a className="hidden shrink-0 text-default-500 no-underline md:inline" href="/">
                {indexPageTitle}
              </a>
              <span className="mx-2 shrink-0" aria-hidden="true">
                /
              </span>
              <span className="truncate">QR Receiver</span>
            </>
          }
          actions={
            <>
              <ReceiverThemeToggle />
              <QrCodeTooltip
                value={receiverUrl}
                placement="bottom"
                tooltip="Show QR code"
                className={TOPBAR_ICON_LINK_CLASS}
              />
              <Tooltip content="Share this page" placement="bottom">
                <WebShareButton title="QR Receiver" url={receiverUrl} className={TOPBAR_ICON_LINK_CLASS} plain />
              </Tooltip>
            </>
          }
        />

        <section className="rounded-xl bg-default-100 p-3" aria-label="QR receiver">
          <div className="flex min-h-56 flex-col items-center justify-center gap-3">
            <div
              className="flex w-full flex-col items-center gap-3 text-center"
              style={{ display: ui.introVisible ? undefined : "none" }}
            >
              <div
                className="inline-flex rounded-xl border border-default-300 bg-content1 p-1"
                role="group"
                aria-label="Receive method"
              >
                <ModeButton mode="camera" activeMode={ui.mode} disabled={ui.modeButtonsDisabled} onSelect={switchMode}>
                  Camera
                </ModeButton>
                {screenAvailable && (
                  <ModeButton
                    mode="screen"
                    activeMode={ui.mode}
                    disabled={ui.modeButtonsDisabled}
                    onSelect={switchMode}
                  >
                    Screen
                  </ModeButton>
                )}
                <ModeButton mode="apng" activeMode={ui.mode} disabled={ui.modeButtonsDisabled} onSelect={switchMode}>
                  APNG file
                </ModeButton>
              </div>
              {ui.mode === "camera" && (
                <p className={HELP_TEXT_CLASS}>Point this camera at the QR stream on the sending screen.</p>
              )}
              {ui.mode === "screen" && (
                <p className={HELP_TEXT_CLASS}>Share the sender window or screen to decode its QR stream.</p>
              )}
              {ui.mode === "apng" && (
                <p className={HELP_TEXT_CLASS}>Choose an APNG exported by the sender to decode it locally.</p>
              )}
              <div
                className={`hint status-line rounded-lg bg-primary-50 px-3 py-2 text-center text-primary${ui.statusError ? " error" : ""}`}
              >
                {ui.status}
              </div>
              {ui.startVisible && (
                <ActionButton type="button" disabled={ui.startDisabled} onClick={() => controller.current?.start()}>
                  {ui.startLabel}
                </ActionButton>
              )}
              {ui.mode === "apng" && (
                <label className="file-picker">
                  <span className={actionControlClassName()}>Choose APNG file</span>
                  <input
                    ref={apngInput}
                    key={ui.fileInputGeneration}
                    type="file"
                    accept=".png,image/png"
                    disabled={ui.apngInputDisabled}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file) controller.current?.selectApng(file)
                    }}
                  />
                </label>
              )}
            </div>

            {ui.partProgress && (
              <div className="part-status" role="status">
                <span className="part-status-label">
                  已经接收 {ui.partProgress.received}/{ui.partProgress.total} 段，请继续接收第{" "}
                  {ui.partProgress.missing.join("，")} 段
                </span>
                {showMultipartActions(ui) && (
                  <ActionRow preview className="part-status-actions">
                    <ActionButton
                      type="button"
                      className="gap-2"
                      onClick={() => {
                        if (ui.mode === "apng") apngInput.current?.click()
                        else controller.current?.start()
                      }}
                    >
                      <ChevronDownIcon className="size-6 -rotate-90" aria-hidden="true" />
                      Continue
                    </ActionButton>
                    <ActionButton
                      type="button"
                      variant="tertiary"
                      className="gap-2"
                      onClick={() => controller.current?.resetParts()}
                    >
                      <RefreshIcon className="size-6" aria-hidden="true" />
                      Other
                    </ActionButton>
                  </ActionRow>
                )}
              </div>
            )}

            <div ref={preview} className="preview-zone" style={{ display: ui.previewVisible ? undefined : "none" }}>
              <div ref={cameraBox} className={`preview${ui.mode === "apng" ? " apng-preview" : ""}`}>
                <video ref={video} muted playsInline style={{ display: ui.mode === "apng" ? "none" : undefined }} />
                <div className="transfer-hud">
                  <div
                    className="progress-status"
                    aria-live="polite"
                    style={{ display: ui.progress.visible ? undefined : "none" }}
                  >
                    <strong>{ui.progress.label}</strong>
                    <span>{ui.progress.eta}</span>
                  </div>
                  <div
                    className="progress"
                    role="progressbar"
                    aria-label="Transfer recovery progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.floor(ui.progress.percent)}
                    style={{ display: ui.progress.visible ? undefined : "none" }}
                  >
                    <div
                      ref={progressBar}
                      className={ui.progress.error ? "error" : ""}
                      style={{ width: `${ui.progress.percent.toFixed(1)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <ReceiverResult result={ui.result} controller={controller} />

            {ui.settingsVisible && (
              <details className="settings mx-auto w-full max-w-[32rem] rounded-xl bg-content1 p-3">
                <summary>Receive settings</summary>
                <div className="row grid gap-3 pt-3">
                  {ui.mode === "camera" && (
                    <NativeSelectField
                      label="Camera"
                      wrapperClassName="camera-picker"
                      labelClassName="text-default-600"
                      variant="receiver"
                      value={ui.cameraId}
                      disabled={ui.cameraDisabled}
                      onChange={(event) => controller.current?.updateCamera(event.currentTarget.value)}
                    >
                      {ui.cameraOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </NativeSelectField>
                  )}
                  {ui.mode === "camera" && (
                    <NativeSelectField
                      label="Capture width"
                      labelClassName="text-default-600"
                      variant="receiver"
                      value={ui.captureWidth}
                      onChange={(event) => controller.current?.updateCaptureWidth(Number(event.currentTarget.value))}
                    >
                      {CAPTURE_WIDTH_OPTIONS.map((value) => (
                        <option key={value} disabled={ui.disabledCaptureWidths.includes(value)}>
                          {value}
                        </option>
                      ))}
                    </NativeSelectField>
                  )}
                  {ui.mode !== "apng" && (
                    <NativeSelectField
                      label="Capture FPS"
                      labelClassName="text-default-600"
                      variant="receiver"
                      value={ui.captureFps}
                      onChange={(event) => controller.current?.updateCaptureFps(Number(event.currentTarget.value))}
                    >
                      {CAPTURE_FPS_OPTIONS.map((value) => (
                        <option key={value} disabled={ui.disabledCaptureFps.includes(value)}>
                          {value}
                        </option>
                      ))}
                    </NativeSelectField>
                  )}
                  <NativeSelectField
                    label="Decode workers"
                    labelClassName="text-default-600"
                    variant="receiver"
                    value={ui.workers}
                    onChange={(event) => controller.current?.updateWorkerCount(Number(event.currentTarget.value))}
                  >
                    {Array.from({ length: workerLimit }, (_, index) => (
                      <option key={index + 1}>{index + 1}</option>
                    ))}
                  </NativeSelectField>
                </div>
                {ui.mode !== "apng" && (
                  <p className="hint settings-actual mt-3 border-t border-divider pt-3">{ui.cameraActual}</p>
                )}
              </details>
            )}
          </div>
        </section>
      </PageContainer>
    </PageShell>
  )
}

function ModeButton({
  mode,
  activeMode,
  disabled,
  onSelect,
  children,
}: {
  mode: ReceiveMode
  activeMode: ReceiveMode
  disabled: boolean
  onSelect: (mode: ReceiveMode) => void
  children: React.ReactNode
}) {
  const active = mode === activeMode
  return (
    <button
      className={`${MODE_BUTTON_CLASS}${active ? " active" : ""}`}
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onSelect(mode)}
    >
      {children}
    </button>
  )
}

function ReceiverResult({
  result,
  controller,
}: {
  result: ReceiverResultState | undefined
  controller: React.RefObject<OpticalReceiverController | null>
}) {
  if (!result) return null
  if (result.kind === "failure") {
    return <OpticalReceivedFailure onRestart={() => controller.current?.reset()} />
  }
  return (
    <OpticalReceivedFileResult
      file={result.file}
      containerBytes={result.containerBytes}
      seconds={result.seconds}
      disallowedMimeTypes={DISALLOWED_MIME_TYPES}
      onRestart={() => controller.current?.reset()}
      onDownload={result.stored ? () => controller.current?.markDownloadStarted() : undefined}
    />
  )
}

function ReceiverThemeToggle() {
  const [isDark, modeSelection, setModeSelection] = useDarkModeSelection()
  return (
    <DarkModeToggle
      modeSelection={modeSelection}
      setModeSelection={setModeSelection}
      aria-label={`Theme (${isDark ? "dark" : "light"})`}
    />
  )
}

const rootElement = document.getElementById("root")
if (!rootElement) throw new Error("Missing React root for QR receiver")
createRoot(rootElement).render(
  <HljsProvider>
    <OpticalReceivePage />
  </HljsProvider>,
)
