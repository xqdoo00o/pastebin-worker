import { createElement } from "react"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_P2P_AUTO_PREVIEW_BYTES, TEXT_MIME_TYPE } from "../../shared/constants.js"
import {
  OpticalReceivedFailure,
  OpticalReceivedFileResult,
  type OpticalReceivedFileResultProps,
} from "../optical/receive/result-renderer.js"
import { classifyReceivedFile } from "../utils/filePreview.js"
import { HljsHookProvider, type HLJSApi } from "../utils/highlight.js"

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL")
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")
const originalShare = Object.getOwnPropertyDescriptor(navigator, "share")
const originalCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare")

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL ?? { configurable: true, value: undefined })
  Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL ?? { configurable: true, value: undefined })
  Object.defineProperty(navigator, "share", originalShare ?? { configurable: true, value: undefined })
  Object.defineProperty(navigator, "canShare", originalCanShare ?? { configurable: true, value: undefined })
})

function renderReceivedFile(options: OpticalReceivedFileResultProps) {
  return render(createElement(OpticalReceivedFileResult, options))
}

describe("optical receiver result rendering", () => {
  it("highlights received text from the sender's language metadata", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:code") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const highlight = vi.fn(() => ({ value: '<span class="hljs-keyword">const</span> answer = 42' }))
    const hljs = {
      listLanguages: () => ["javascript"],
      highlight,
    } as unknown as HLJSApi

    const { container: result } = render(
      createElement(
        HljsHookProvider,
        { value: () => hljs },
        createElement(OpticalReceivedFileResult, {
          file: {
            name: "answer.txt",
            type: "text/plain; x-pb-highlight=javascript",
            bytes: new TextEncoder().encode("const answer = 42"),
            compression: "none",
            transmittedSize: 17,
            part: { index: 0, count: 0, transferId: undefined },
          },
          containerBytes: 128,
          seconds: 1,
          onRestart: vi.fn(),
        }),
      ),
    )

    expect(highlight).toHaveBeenCalledWith("const answer = 42", { language: "javascript" })
    expect(result.querySelector(".hljs-keyword")?.textContent).toBe("const")
    expect(result.querySelector(".received-preview-detail")?.textContent).toBe("17 Bytes · javascript · 0.1 KB/s")
  })

  it("does not infer a language from the received filename", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:plain") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const highlight = vi.fn(() => ({ value: "unexpected" }))
    const hljs = {
      listLanguages: () => ["javascript"],
      highlight,
    } as unknown as HLJSApi

    const { container: result } = render(
      createElement(
        HljsHookProvider,
        { value: () => hljs },
        createElement(OpticalReceivedFileResult, {
          file: {
            name: "answer.js",
            type: "text/plain",
            bytes: new TextEncoder().encode("const answer = 42"),
            compression: "none",
            transmittedSize: 17,
            part: { index: 0, count: 0, transferId: undefined },
          },
          containerBytes: 128,
          seconds: 1,
          onRestart: vi.fn(),
        }),
      ),
    )

    expect(highlight).not.toHaveBeenCalled()
    expect(result.querySelector(".received-preview-note")?.textContent).toBe("const answer = 42")
    expect(result.querySelector(".received-preview-detail")?.textContent).toBe("17 Bytes · 0.1 KB/s")
  })

  it("renders a verified text preview with shared download and restart actions", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:received") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const autoDownload = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const restart = vi.fn()

    const { container: result } = renderReceivedFile({
      file: {
        name: "note.txt",
        type: "text/plain",
        bytes: new TextEncoder().encode("hello"),
        compression: "none",
        transmittedSize: 5,
        part: { index: 0, count: 0, transferId: undefined },
      },
      containerBytes: 128,
      seconds: 2,
      onRestart: restart,
    })

    expect(result.querySelector(".received-verified-badge")?.textContent).toBe("Verified")
    expect(result.querySelector(".received-preview-note")?.textContent).toBe("hello")
    expect(result.querySelector(".received-preview-content")).not.toBeNull()
    expect(result.querySelector(".received-preview-line-numbers")?.textContent).toBe("1")
    expect(autoDownload).not.toHaveBeenCalled()
    const download = result.querySelector<HTMLAnchorElement>("a.primary-button")
    expect(download?.href).toBe("blob:received")
    expect(download?.textContent).toBe("Save")
    expect(download?.querySelector("svg")).not.toBeNull()
    expect(result.querySelector(".received-preview-actions")?.contains(download ?? null)).toBe(true)
    const copy = [...result.querySelectorAll("button")].find((button) => button.textContent === "Copy")
    expect(copy?.querySelector("svg")).not.toBeNull()
    const receiveAnother = result.querySelector<HTMLButtonElement>('button[aria-label="Other"]')
    expect(receiveAnother?.classList.contains("tertiary-button")).toBe(true)
    expect(receiveAnother?.querySelector("svg")).not.toBeNull()
    receiveAnother?.click()
    expect(restart).toHaveBeenCalledOnce()
  })

  it("automatically downloads a received file without an inline preview", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:binary") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const autoDownload = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const onDownload = vi.fn()

    const { container: result } = renderReceivedFile({
      file: {
        name: "archive.bin",
        type: "application/octet-stream",
        bytes: Uint8Array.of(0xff, 0xfe, 0x00),
        compression: "none",
        transmittedSize: 3,
        part: { index: 0, count: 0, transferId: undefined },
      },
      containerBytes: 3,
      seconds: 1,
      onRestart: vi.fn(),
      onDownload,
    })

    expect(result.querySelector(".received-preview-placeholder")?.textContent).toContain("Preview unavailable")
    expect(result.querySelector(".received-preview-placeholder")?.textContent).toContain(
      "A download was started automatically",
    )
    expect(result.querySelector(".received-preview-empty-type")).toBeNull()
    expect(autoDownload).toHaveBeenCalledOnce()
    const automaticLink = autoDownload.mock.instances[0] as HTMLAnchorElement
    expect(automaticLink.href).toBe("blob:binary")
    expect(automaticLink.download).toBe("archive.bin")
    expect(automaticLink.isConnected).toBe(false)
    expect(onDownload).toHaveBeenCalledOnce()
  })

  it("does not automatically download a previewable image", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:image") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const autoDownload = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)

    const { container: result } = renderReceivedFile({
      file: {
        name: "photo.png",
        type: "image/png",
        bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
        compression: "none",
        transmittedSize: 4,
        part: { index: 0, count: 0, transferId: undefined },
      },
      containerBytes: 4,
      seconds: 1,
      onRestart: vi.fn(),
    })

    expect(result.querySelector("img")?.getAttribute("src")).toBe("blob:image")
    expect(autoDownload).not.toHaveBeenCalled()
  })

  it("loads a large text preview only after it is requested", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:received") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const share = vi.fn((_data: ShareData) => Promise.resolve())
    const canShare = vi.fn((_data: ShareData) => true)
    Object.defineProperty(navigator, "share", { configurable: true, value: share })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare })
    const content = new Uint8Array(MAX_P2P_AUTO_PREVIEW_BYTES).fill(0x61)

    const { container: result } = renderReceivedFile({
      file: {
        name: "large.txt",
        type: "text/plain",
        bytes: content,
        compression: "none",
        transmittedSize: content.length,
        part: { index: 0, count: 0, transferId: undefined },
      },
      containerBytes: content.length,
      seconds: 1,
      onRestart: vi.fn(),
    })

    expect(result.querySelector(".received-preview-note")).toBeNull()
    expect(result.querySelector(".received-preview-empty-copy strong")?.textContent).toBe("Large text file")
    expect(result.querySelector(".received-preview-empty-type")).toBeNull()
    const preview = [...result.querySelectorAll("button")].find((button) => button.textContent === "Preview anyway")
    expect(preview?.parentElement?.classList.contains("deferred-preview")).toBe(true)
    expect(preview?.querySelector("svg")).toBeNull()
    preview?.click()

    await vi.waitFor(() => {
      expect(result.querySelector(".received-preview-note")?.textContent).toHaveLength(content.length)
    })

    result.querySelector<HTMLButtonElement>('button[aria-label="Share"]')?.click()
    await vi.waitFor(() => expect(share).toHaveBeenCalledOnce())
    const shared = share.mock.calls[0][0]
    expect(shared.text).toBeUndefined()
    expect(shared.files?.[0]).toMatchObject({ name: "large.txt", type: "text/plain", size: content.length })
  })

  it("shows copied feedback after copying", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:received") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    try {
      const { container: result } = renderReceivedFile({
        file: {
          name: "copy.txt",
          type: "text/plain",
          bytes: new TextEncoder().encode("copy me"),
          compression: "none",
          transmittedSize: 7,
          part: { index: 0, count: 0, transferId: undefined },
        },
        containerBytes: 7,
        seconds: 1,
        onRestart: vi.fn(),
      })

      const copy = [...result.querySelectorAll("button")].find((button) => button.textContent === "Copy")
      copy?.click()
      await vi.waitFor(() => expect(copy?.textContent).toBe("Copied"))
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
      else Reflect.deleteProperty(navigator, "clipboard")
    }
  })

  it("renders a line-number gutter matching multiline received text", () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:received") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const { container: result } = renderReceivedFile({
      file: {
        name: "multiline.txt",
        type: "text/plain",
        bytes: new TextEncoder().encode("first\nsecond\nthird"),
        compression: "none",
        transmittedSize: 18,
        part: { index: 0, count: 0, transferId: undefined },
      },
      containerBytes: 18,
      seconds: 1,
      onRestart: vi.fn(),
    })

    expect(result.querySelector(".received-preview-line-numbers")?.textContent).toBe("1\n2\n3")
    expect(result.querySelector<HTMLElement>(".received-preview-note")?.style.marginLeft).toBe("3ch")
    expect(result.querySelector<HTMLElement>(".received-preview-note")?.style.width).toBe("calc(100% - 3ch)")
  })

  it("renders an OPFS-backed result without reading it until text preview is requested", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:stored") })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const onDownload = vi.fn()
    const file = new File(["stored text"], "stored.txt", { type: "text/plain" })

    const { container: result } = renderReceivedFile({
      file,
      containerBytes: file.size,
      seconds: 1,
      onRestart: vi.fn(),
      onDownload,
    })

    expect(result.querySelector(".received-preview-note")).toBeNull()
    expect(result.querySelector(".received-preview-detail")?.textContent).toBe("11 Bytes · 0.0 KB/s")
    result.querySelector<HTMLAnchorElement>("a.primary-button")?.click()
    expect(onDownload).toHaveBeenCalledOnce()

    const preview = [...result.querySelectorAll("button")].find((button) => button.textContent === "Preview anyway")
    preview?.click()
    await vi.waitFor(() => expect(result.querySelector(".received-preview-note")?.textContent).toBe("stored text"))
  })

  it("does not inline-preview a QR image whose MIME is disabled by configuration", () => {
    const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(() => "blob:disabled")
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const { container: result } = renderReceivedFile({
      file: {
        name: "disabled.png",
        type: "Image/PNG; charset=binary",
        bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0),
        compression: "none",
        transmittedSize: 5,
        part: { index: 0, count: 0, transferId: undefined },
      },
      containerBytes: 5,
      seconds: 1,
      onRestart: vi.fn(),
      disallowedMimeTypes: ["image/png"],
    })

    expect(result.querySelector("img")).toBeNull()
    expect(result.querySelector(".received-preview-placeholder")?.textContent).toContain("Preview unavailable")
    expect(result.querySelector(".received-preview-placeholder")?.textContent).not.toContain("text/plain")
    expect(result.querySelector<HTMLAnchorElement>("a.primary-button")?.download).toBe("disabled.png")
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe(TEXT_MIME_TYPE.toLowerCase())
  })

  it("renders a retry action for an unusable transfer", () => {
    const restart = vi.fn()
    const { container: result } = render(createElement(OpticalReceivedFailure, { onRestart: restart }))

    result.querySelector("button")?.click()
    expect(restart).toHaveBeenCalledOnce()
  })
})

describe("optical receiver previews", () => {
  it("automatically previews UTF-8 content without relying on a text MIME type", () => {
    const preview = classifyReceivedFile(
      "notes.data",
      "application/octet-stream",
      new TextEncoder().encode("hello from the camera"),
    )

    expect(preview).toMatchObject({
      kind: "text",
      text: "hello from the camera",
    })
  })

  it("uses the regular receiver's media extension fallback without rewriting the declared type", () => {
    const preview = classifyReceivedFile("photo.png", "application/octet-stream", Uint8Array.of(0x89, 0x50))

    expect(preview).toEqual({ kind: "image", contentType: "application/octet-stream" })
  })

  it("does not render invalid UTF-8 as text", () => {
    const preview = classifyReceivedFile("broken.txt", "text/plain", Uint8Array.of(0xff, 0xfe))

    expect(preview.kind).toBe("download")
  })

  it("requires confirmation before rendering text above the regular receiver limit", () => {
    const preview = classifyReceivedFile("large.txt", "text/plain", new Uint8Array(1024 * 1024 + 1))

    expect(preview.kind).toBe("deferred-text")
  })

  it("does not treat a large non-text MIME as text, matching the P2P receiver", () => {
    const preview = classifyReceivedFile("large.json", "application/json", new Uint8Array(1024 * 1024 + 1))

    expect(preview.kind).toBe("download")
  })
})
