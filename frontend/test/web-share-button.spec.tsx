import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WebShareButton } from "../components/WebShareButton.js"
import { MAX_WEB_SHARE_TEXT_LENGTH } from "../utils/webShare.js"

const originalShare = Object.getOwnPropertyDescriptor(navigator, "share")
const originalCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare")
const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent")

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, "share", originalShare ?? { configurable: true, value: undefined })
  Object.defineProperty(navigator, "canShare", originalCanShare ?? { configurable: true, value: undefined })
  if (originalUserAgent) Object.defineProperty(navigator, "userAgent", originalUserAgent)
})

describe("WebShareButton", () => {
  it("shares preview text", () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "share", { configurable: true, value: share })

    render(<WebShareButton title="note.txt" text="Hello from Pastebin" />)
    screen.getByRole("button", { name: "Share" }).click()

    expect(share).toHaveBeenCalledWith({ title: "note.txt", text: "Hello from Pastebin" })
  })

  it("shares preview files when the browser supports file sharing", () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const canShare = vi.fn().mockReturnValue(true)
    const file = new File(["music"], "song.mp3", { type: "audio/mpeg" })
    Object.defineProperty(navigator, "share", { configurable: true, value: share })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare })

    render(<WebShareButton title={file.name} file={file} />)
    screen.getByRole("button", { name: "Share" }).click()

    expect(canShare).toHaveBeenCalledWith({ title: "song.mp3", files: [file] })
    expect(share).toHaveBeenCalledWith({ title: "song.mp3", files: [file] })
  })

  it("shares text through 120K and switches to its file above 120K", () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const file = new File(["fallback"], "note.txt", { type: "text/plain" })
    Object.defineProperty(navigator, "share", { configurable: true, value: share })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true })

    const { rerender } = render(
      <WebShareButton title={file.name} text={"a".repeat(MAX_WEB_SHARE_TEXT_LENGTH)} file={file} />,
    )
    screen.getByTitle("Share text").click()
    expect(share).toHaveBeenLastCalledWith({ title: "note.txt", text: "a".repeat(MAX_WEB_SHARE_TEXT_LENGTH) })

    rerender(<WebShareButton title={file.name} text={"a".repeat(MAX_WEB_SHARE_TEXT_LENGTH + 1)} file={file} />)
    screen.getByTitle("Share file").click()
    expect(share).toHaveBeenLastCalledWith({ title: "note.txt", files: [file] })
  })

  it("does not repeat canShare when a parent rerenders with unchanged share data", () => {
    const canShare = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockResolvedValue(undefined) })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare })

    const { rerender } = render(<WebShareButton title="QR Receiver" url="https://example.com/receive" plain />)
    expect(canShare).toHaveBeenCalledOnce()

    rerender(<WebShareButton title="QR Receiver" url="https://example.com/receive" plain />)
    expect(canShare).toHaveBeenCalledOnce()
  })

  it("hides a file rejected by Chromium's filename and MIME allowlists", () => {
    const canShare = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
    })
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockResolvedValue(undefined) })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare })

    render(<WebShareButton title="archive.zip" file={new File(["zip"], "archive.zip", { type: "application/zip" })} />)

    expect(screen.queryByRole("button", { name: "Share" })).toBeNull()
    expect(canShare).not.toHaveBeenCalled()
  })
})
