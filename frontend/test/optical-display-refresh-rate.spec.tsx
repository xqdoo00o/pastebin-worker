import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PanelSettingsPanel } from "../components/PasteSettingPanel.js"
import { defaultOpticalTransferSettings, type PasteSetting } from "../utils/pasteSetting.js"
import { stubBrowserFunctions, unStubBrowserFunctions } from "./testUtils.js"

import "@testing-library/jest-dom/vitest"

const initialSetting: PasteSetting = {
  uploadKind: "short",
  transferMethod: "optical",
  archiveCompression: "deflate",
  expiration: "",
  readLimit: "0",
  manageUrl: "",
  doEncrypt: false,
  verifyP2P: false,
  optical: { ...defaultOpticalTransferSettings(), txFps: 144 },
}

describe("QR camera TX FPS limit", () => {
  beforeEach(() => {
    stubBrowserFunctions()
  })

  afterEach(() => {
    cleanup()
    unStubBrowserFunctions()
  })

  it("removes rates above the measured display limit and clamps the current setting", async () => {
    const callbacks: FrameRequestCallback[] = []
    let nextFrameId = 1
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback)
        return nextFrameId++
      }),
    )
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    vi.spyOn(console, "info").mockImplementation(() => undefined)

    function Harness() {
      const [setting, setSetting] = useState(initialSetting)
      return <PanelSettingsPanel setting={setting} onSettingChange={setSetting} config={__WRANGLER_CONFIG__} />
    }

    render(<Harness />)
    act(() => {
      for (let frame = 0; frame <= 60; frame++) callbacks.shift()?.((frame * 1000) / 118.1)
    })

    const select = screen.getByRole("combobox", { name: "Optical TX FPS" })
    await waitFor(() => expect(select).toHaveValue("120"))
    expect(Array.from(select.querySelectorAll("option"), (option) => Number(option.value))).toEqual([
      10, 15, 20, 24, 30, 50, 60, 90, 120,
    ])
  })
})
