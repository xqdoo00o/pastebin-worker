import type { ComponentProps, ReactNode } from "react"

import type { PublicEnv } from "../../shared/interfaces.js"
import { DarkModeToggle } from "../components/DarkModeToggle.js"
import { LocalUploadsSidebar } from "../components/LocalUploadsSidebar.js"
import { PanelSettingsPanel } from "../components/PasteSettingPanel.js"
import { PasteInputPanel } from "../components/PasteInputPanel.js"
import { PasteFooter, PasteInfoHeader, PasteWorkspace, TransferActionBar } from "../components/PasteBinLayout.js"
import { PageContainer, PageShell } from "../components/ui/index.js"

interface PasteBinViewProps {
  config: PublicEnv
  editor: Omit<ComponentProps<typeof PasteInputPanel>, "className">
  settings: Omit<ComponentProps<typeof PanelSettingsPanel>, "footer">
  actions: ComponentProps<typeof TransferActionBar>
  transferPanels: ReactNode
  sidebar: Omit<ComponentProps<typeof LocalUploadsSidebar>, "className">
  themeToggle: ComponentProps<typeof DarkModeToggle>
  errorModal?: ReactNode
}

/** Shared server/client presentation. Keeping browser transfer controllers out
 * of this module prevents Worker SSR from bundling P2P and optical runtimes. */
export function PasteBinView({
  config,
  editor,
  settings,
  actions,
  transferPanels,
  sidebar,
  themeToggle,
  errorModal,
}: PasteBinViewProps) {
  return (
    <PageShell>
      <PageContainer className="grow max-w-[88rem] px-2 lg:px-4 2xl:px-0">
        <PasteInfoHeader config={config} themeToggle={<DarkModeToggle {...themeToggle} />} />
        <PasteWorkspace
          editor={<PasteInputPanel {...editor} className="mt-6 mb-4" />}
          panels={
            <>
              <PanelSettingsPanel {...settings} footer={<TransferActionBar {...actions} />} />
              {transferPanels}
            </>
          }
          sidebar={<LocalUploadsSidebar {...sidebar} />}
        />
      </PageContainer>
      <PasteFooter config={config} />
      {errorModal}
    </PageShell>
  )
}
