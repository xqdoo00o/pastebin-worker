import { afterEach, describe, expect, it } from "vitest"
import { ReceiverPreviewLayout } from "../optical/receive/preview-layout.js"

const originalInnerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight")

afterEach(() => {
  if (originalInnerWidth) Object.defineProperty(window, "innerWidth", originalInnerWidth)
  if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight)
})

describe("ReceiverPreviewLayout", () => {
  it("fits compact landscape previews, then clears fixed dimensions for normal layouts", () => {
    const video = document.createElement("video")
    const preview = document.createElement("div")
    const cameraBox = document.createElement("div")
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 })
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 })
    Object.defineProperty(preview, "clientWidth", { configurable: true, value: 900 })
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 })
    const layout = new ReceiverPreviewLayout(video, preview, cameraBox)

    layout.sync()

    expect(cameraBox.style.aspectRatio).toBe("1920 / 1080")
    expect(preview.style.width).toBe("640px")
    expect(cameraBox.style.height).toBe("360px")

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 })
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 })
    layout.sync()
    expect(preview.style.width).toBe("")
    expect(cameraBox.style.width).toBe("")
    expect(cameraBox.style.height).toBe("")

    layout.reset()
    expect(cameraBox.style.aspectRatio).toBe("")
  })
})
