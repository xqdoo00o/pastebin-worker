import { describe, expect, it } from "vitest"

import { isChromiumBrowser } from "../utils/browser.js"
import { isChromiumWebShareFileAllowed, isFileShareAllowedByBrowser } from "../utils/webShare.js"

describe("Web Share browser policy", () => {
  it("detects Chromium from client hints or the desktop user agent", () => {
    expect(
      isChromiumBrowser({
        userAgent: "ignored",
        userAgentData: { brands: [{ brand: "Chromium", version: "140" }] },
      }),
    ).toBe(true)
    expect(isChromiumBrowser({ userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36" })).toBe(true)
    expect(isChromiumBrowser({ userAgent: "Mozilla/5.0 CriOS/140.0 Mobile/15E148 Safari/604.1" })).toBe(false)
    expect(isChromiumBrowser({ userAgent: "Mozilla/5.0 Firefox/142.0" })).toBe(false)
  })

  it("requires both an allowed extension and an allowed MIME type for Chromium", () => {
    expect(isChromiumWebShareFileAllowed({ name: "PHOTO.PNG", type: "image/png" })).toBe(true)
    expect(isChromiumWebShareFileAllowed({ name: "photo.exe", type: "image/png" })).toBe(false)
    expect(isChromiumWebShareFileAllowed({ name: "photo.png", type: "application/octet-stream" })).toBe(false)
  })

  it("does not apply Chromium's private policy to other browsers", () => {
    expect(
      isFileShareAllowedByBrowser(
        { name: "archive.zip", type: "application/zip" },
        { userAgent: "Mozilla/5.0 Firefox/142.0" },
      ),
    ).toBe(true)
  })
})
