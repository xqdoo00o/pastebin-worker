import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PwaInstallButton } from "../components/PwaInstallButton.js"
import { registerPwa } from "../utils/pwa.js"

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("PWA installation", () => {
  it("shows installation only when the browser offers it and consumes each prompt once", async () => {
    render(<PwaInstallButton />)
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
    const event = new Event("beforeinstallprompt", { cancelable: true })
    const prompt = vi.fn(() => Promise.resolve({ outcome: "dismissed" }))
    Object.assign(event, { prompt })
    act(() => {
      window.dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Install app" }))
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("removes installation controls when installation completes", () => {
    render(<PwaInstallButton />)
    act(() => {
      window.dispatchEvent(new Event("beforeinstallprompt"))
    })
    expect(screen.getByRole("button", { name: "Install app" })).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new Event("appinstalled"))
    })
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("shows iOS home screen instructions", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    render(<PwaInstallButton />)
    fireEvent.click(screen.getByRole("button", { name: "Install app" }))
    expect(screen.getByRole("dialog", { name: "Install app" })).toHaveTextContent("Add to Home Screen")
    fireEvent.click(screen.getByRole("button", { name: "Got it" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("clears a failed prompt's status when the app is installed through the browser", async () => {
    render(<PwaInstallButton />)
    const event = new Event("beforeinstallprompt")
    Object.assign(event, { prompt: vi.fn(() => Promise.reject(new Error("prompt failed"))) })
    act(() => {
      window.dispatchEvent(event)
    })
    fireEvent.click(screen.getByRole("button", { name: "Install app" }))
    expect(await screen.findByRole("status")).toHaveTextContent("Install from your browser menu.")
    act(() => {
      window.dispatchEvent(new Event("appinstalled"))
    })
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("hides installation in an installed app", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }))
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    render(<PwaInstallButton />)
    expect(screen.queryByRole("button", { name: "Install app" })).not.toBeInTheDocument()
  })

  it("registers the production service worker with fresh updates, but skips development", () => {
    const register = vi.fn(() => Promise.resolve({}))
    vi.stubGlobal("navigator", { serviceWorker: { register } })
    vi.stubGlobal("isSecureContext", true)
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete")
    vi.stubEnv("PROD", false)
    registerPwa()
    expect(register).not.toHaveBeenCalled()
    vi.stubEnv("PROD", true)
    registerPwa()
    expect(register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/", updateViaCache: "none" })
  })
})
