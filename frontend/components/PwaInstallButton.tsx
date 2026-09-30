import { useEffect, useState } from "react"
import { DownloadIcon } from "./icons.js"
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "./ui/index.js"

interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>
}

export function PwaInstallButton() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)
  const [isIos, setIsIos] = useState(false)
  const [status, setStatus] = useState<"idle" | "help" | "failed">("idle")

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)")
    const isInstalled = () => standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone
    if (isInstalled()) return

    setIsIos(
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    )
    const onPrompt = (event: Event) => {
      if (isInstalled()) return
      event.preventDefault()
      setStatus("idle")
      setInstallPrompt(event as InstallPromptEvent)
    }
    const onInstalled = () => {
      setInstallPrompt(null)
      setIsIos(false)
      setStatus("idle")
    }
    const onDisplayModeChange = () => {
      if (isInstalled()) onInstalled()
    }
    window.addEventListener("beforeinstallprompt", onPrompt)
    window.addEventListener("appinstalled", onInstalled)
    standalone.addEventListener("change", onDisplayModeChange)
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt)
      window.removeEventListener("appinstalled", onInstalled)
      standalone.removeEventListener("change", onDisplayModeChange)
    }
  }, [])

  async function install() {
    if (!installPrompt) {
      setStatus("help")
      return
    }
    // Each browser event can only prompt once, including after dismissal.
    setInstallPrompt(null)
    try {
      await installPrompt.prompt()
    } catch {
      setStatus("failed")
    }
  }

  return (
    <>
      {(installPrompt || isIos) && (
        <Button type="button" variant="light" size="sm" onPress={() => void install()} className="shrink-0 gap-1.5">
          <DownloadIcon className="size-5" aria-hidden="true" />
          <span>Install app</span>
        </Button>
      )}
      {status === "failed" && (
        <span role="status" className="text-xs text-default-500">
          Install from your browser menu.
        </span>
      )}
      <Modal isOpen={status === "help"} onClose={() => setStatus("idle")}>
        <ModalContent aria-labelledby="pwa-install-title">
          <ModalHeader id="pwa-install-title">Install app</ModalHeader>
          <ModalBody>Open this page in Safari, tap Share, then choose Add to Home Screen and tap Add.</ModalBody>
          <ModalFooter>
            <Button type="button" onPress={() => setStatus("idle")}>
              Got it
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  )
}
