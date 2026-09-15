import type { PublicEnv } from "../../shared/interfaces.js"
import type { PasteEditState } from "../models/paste.js"
import { createInitialPasteSetting, defaultOpticalTransferSettings } from "../utils/pasteSetting.js"
import { PasteBinView } from "./PasteBinView.js"

const ignore = () => undefined
const ignoreDelete = () => Promise.resolve(false)

/** Server-renderable initial state with no dependency on browser transfer
 * controllers. Its props deliberately match PasteBin's first client render. */
export function PasteBinInitialView({ config }: { config: PublicEnv }) {
  const editorState: PasteEditState = {
    editKind: config.DEFAULT_TAB === "file" ? "file" : "edit",
    editContent: "",
    files: [],
    editHighlightLang: "plaintext",
  }
  const setting = createInitialPasteSetting(config, defaultOpticalTransferSettings(config))
  const isUploadMode = setting.transferMethod === "upload"
  const manageMode = isUploadMode && setting.uploadKind === "manage"

  return (
    <PasteBinView
      config={config}
      editor={{
        isPasteLoading: false,
        state: editorState,
        onStateChange: ignore,
        config,
        skipFileSizeLimit: !isUploadMode,
        showModal: ignore,
      }}
      settings={{
        config,
        files: [],
        hasEditContent: false,
        setting,
        onSettingChange: ignore,
      }}
      actions={{
        selectedTransfer: setting.transferMethod,
        isPending: false,
        updateDisabled: true,
        startDisabled: true,
        newUploadDisabled: true,
        manageMode,
        deleteDisabled: true,
        onUpdate: ignore,
        onStop: ignore,
        onStart: ignore,
        onNewUpload: ignore,
        onDelete: ignore,
      }}
      transferPanels={null}
      sidebar={{ uploads: [], onDeleteUpload: ignoreDelete }}
      themeToggle={{ modeSelection: "system", setModeSelection: ignore }}
    />
  )
}
