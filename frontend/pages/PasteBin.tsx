import { lazy, Suspense, useCallback, useRef, useState, useTransition } from "react"

import { useDarkModeSelection } from "../components/DarkModeToggle.js"
import { useErrorModal } from "../components/ErrorModal.js"
import { UploadedPanel } from "../components/UploadedPanel.js"
import { P2PTransferPanel } from "../components/P2PTransferPanel.js"
import type { PasteEditState } from "../models/paste.js"

import type { PublicEnv } from "../../shared/interfaces.js"
import { MAX_URL_REDIRECT_LEN, OPTICAL_RECEIVER_PATH } from "../../shared/constants.js"

import { isLegalUrl } from "../../shared/verify.js"
import {
  createInitialPasteSetting,
  defaultOpticalTransferSettings,
  type PasteSetting,
  type TransferMethod,
} from "../utils/pasteSetting.js"
import { useManagedPasteLoader } from "../utils/useManagedPaste.js"
import { usePasteTransferController } from "../utils/usePasteTransferController.js"
import { loadOpticalSenderSettings } from "../optical/shared/settings.js"
import { PasteBinView } from "./PasteBinView.js"
import "../style.css"

const OpticalTransferPanel = lazy(async () => {
  const module = await import("../components/OpticalTransferPanel.js")
  return { default: module.OpticalTransferPanel }
})

export function PasteBin({ config }: { config: PublicEnv }) {
  const [editorState, setEditorState] = useState<PasteEditState>({
    editKind: config.DEFAULT_TAB === "file" ? "file" : "edit",
    editContent: "",
    files: [],
    editHighlightLang: "plaintext",
  })
  const [pasteSetting, setPasteSetting] = useState<PasteSetting>(() =>
    createInitialPasteSetting(config, loadOpticalSenderSettings(defaultOpticalTransferSettings(config))),
  )
  const pasteSettingsByMethodRef = useRef<Partial<Record<TransferMethod, PasteSetting>>>({})
  pasteSettingsByMethodRef.current[pasteSetting.transferMethod] = pasteSetting
  const onPasteSettingChange = useCallback((nextSetting: PasteSetting) => {
    setPasteSetting((currentSetting) => {
      if (nextSetting.transferMethod === currentSetting.transferMethod) return nextSetting

      const savedSetting = pasteSettingsByMethodRef.current[nextSetting.transferMethod]
      if (!savedSetting) return nextSetting

      // Optical preferences are global and persisted separately; keep the latest
      // value while restoring the mode-specific upload/P2P fields.
      return { ...savedSetting, transferMethod: nextSetting.transferMethod, optical: nextSetting.optical }
    })
  }, [])

  const [isInitPasteLoading, startFetchingInitPaste] = useTransition()
  const [, modeSelection, setModeSelection] = useDarkModeSelection()
  const { errorModal, showModal, handleError, handleFailedResp } = useErrorModal()
  const transfer = usePasteTransferController({
    config,
    editorState,
    pasteSetting,
    settingsByMethodRef: pasteSettingsByMethodRef,
    setPasteSetting,
    showModal,
    handleError,
    handleFailedResponse: handleFailedResp,
  })
  const { p2p, optical } = transfer
  const handleOpticalError = useCallback((error: Error) => handleError("Error on QR Transfer", error), [handleError])
  const currentOpticalSettings = pasteSetting.optical

  useManagedPasteLoader({
    config,
    initialSetting: pasteSetting,
    setPasteSetting,
    setPasteResponse: transfer.setPasteResponse,
    setEditorState,
    setLastPasteUpdate: transfer.setLastPasteUpdate,
    startTransition: startFetchingInitPaste,
    showError: showModal,
    handleError,
    handleFailedResponse: handleFailedResp,
  })

  return (
    <PasteBinView
      config={config}
      editor={{
        isPasteLoading: isInitPasteLoading,
        state: editorState,
        onStateChange: setEditorState,
        config,
        skipFileSizeLimit: !transfer.isUploadMode,
        showModal,
      }}
      settings={{
        config,
        files: editorState.editKind === "file" ? editorState.files : [],
        hasEditContent: editorState.editKind === "edit" && editorState.editContent.length > 0,
        setting: pasteSetting,
        onSettingChange: onPasteSettingChange,
      }}
      actions={{
        activeTransfer: transfer.hasActiveOpticalSession ? "optical" : transfer.hasActiveP2PSession ? "p2p" : undefined,
        selectedTransfer: pasteSetting.transferMethod,
        isPending: transfer.isUploadPending,
        updateDisabled: transfer.updateDisabled,
        startDisabled: transfer.startDisabled,
        newUploadDisabled: transfer.newUploadDisabled,
        manageMode: transfer.isManageMode,
        deleteDisabled: transfer.deleteDisabled,
        onUpdate: transfer.update,
        onStop: transfer.cancel,
        onStart: transfer.start,
        onNewUpload: transfer.startNewUpload,
        onDelete: transfer.deleteManagedPaste,
      }}
      transferPanels={
        <>
          {optical.file !== undefined && (
            <div hidden={!transfer.isOpticalMode} className="w-full">
              <Suspense
                fallback={
                  <div
                    role="status"
                    className="flex min-h-48 w-full items-center justify-center rounded-2xl bg-content1 text-sm text-default-500"
                  >
                    Loading QR transfer…
                  </div>
                }
              >
                <OpticalTransferPanel
                  file={optical.file}
                  highlightLanguage={optical.highlightLanguage}
                  settings={currentOpticalSettings}
                  receiverUrl={`${config.DEPLOY_URL}${OPTICAL_RECEIVER_PATH}`}
                  onTransferError={handleOpticalError}
                  className="w-full"
                />
              </Suspense>
            </div>
          )}
          {transfer.hasP2PPanel && (
            <P2PTransferPanel
              hidden={!transfer.isP2PMode}
              isLoading={transfer.isP2PMode && transfer.isUploadPending}
              response={p2p.response}
              currentFile={p2p.currentFile}
              status={p2p.status}
              peers={p2p.peers}
              iceServers={p2p.iceServers}
              onCancel={transfer.cancel}
              className="w-full"
            />
          )}
          {transfer.hasUploadResultPanel && (
            <UploadedPanel
              hidden={!transfer.isUploadMode}
              isLoading={transfer.isUploadMode && transfer.isUploadPending}
              loadingProgress={transfer.loadingProgress}
              onCancel={transfer.cancel}
              pasteResponse={transfer.pasteResponse}
              encryptionKey={transfer.uploadedEncryptionKey}
              highlightLang={editorState.editKind === "edit" ? editorState.editHighlightLang : undefined}
              isUrlPaste={
                editorState.editKind === "edit" &&
                editorState.editContent.length > 0 &&
                editorState.editContent.length <= MAX_URL_REDIRECT_LEN &&
                isLegalUrl(editorState.editContent)
              }
              className="w-full"
            />
          )}
        </>
      }
      sidebar={{
        uploads: transfer.localUploads,
        onDeleteUpload: transfer.deleteLocalUpload,
        scrollToKey: transfer.latestLocalUploadKey,
      }}
      themeToggle={{ modeSelection, setModeSelection }}
      errorModal={errorModal}
    />
  )
}
