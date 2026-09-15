import { describe, expect, it } from "vitest"

import {
  initialReceiverUiState,
  ReceiverView,
  showMultipartActions,
  type ReceiverUiState,
} from "../optical/receive/receiver-view.js"

function createView() {
  let state: ReceiverUiState = structuredClone(initialReceiverUiState)
  const view = new ReceiverView((update) => {
    state = update(state)
  })
  return { view, state: () => state }
}

describe("optical receiver React state bridge", () => {
  it("derives mode controls without mutating DOM elements", () => {
    const { view, state } = createView()

    view.updateMode("apng")
    expect(state()).toMatchObject({ mode: "apng", startVisible: false, startLabel: "Start camera" })

    view.offerRetry("screen", "sharing stopped")
    expect(state()).toMatchObject({
      mode: "screen",
      status: "✗ sharing stopped",
      statusError: true,
      startVisible: true,
      startDisabled: false,
      startLabel: "Start screen capture",
      previewVisible: false,
    })
  })

  it("resets one transfer while preserving multipart progress and settings", () => {
    const { view, state } = createView()
    view.patch({
      captureWidth: 1920,
      workers: 4,
      partProgress: { received: 2, total: 4, missing: [3, 4] },
      result: { kind: "failure" },
    })
    view.patchProgress({ visible: true, percent: 74, error: true })

    view.resetTransfer("camera")

    expect(state()).toMatchObject({
      captureWidth: 1920,
      workers: 4,
      partProgress: { received: 2, total: 4, missing: [3, 4] },
      result: undefined,
      fileInputGeneration: 1,
      progress: { visible: false, percent: 0, label: "0%", error: false },
    })
  })

  it("shows multipart actions between parts and hides them while the next part is processing", () => {
    const { view, state } = createView()
    view.patch({ partProgress: { received: 1, total: 3, missing: [2, 3] } })
    expect(showMultipartActions(state())).toBe(true)

    view.patch({ startDisabled: true })
    expect(showMultipartActions(state())).toBe(false)

    view.resetTransfer("apng")
    expect(showMultipartActions(state())).toBe(true)
    view.patch({ apngInputDisabled: true })
    expect(showMultipartActions(state())).toBe(false)
  })
})
