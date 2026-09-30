export function registerPwa() {
  if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return

  const register = () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((error: unknown) => {
      console.warn("PWA registration failed:", error)
    })
  }
  if (document.readyState === "complete") register()
  else window.addEventListener("load", register, { once: true })
}
