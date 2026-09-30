import { beforeEach, describe, expect, it } from "vitest"
import {
  FRAME_BYTES_OPTIONS,
  frameBytesOptionsForEcc,
  loadOpticalReceiverSettings,
  loadOpticalSenderSettings,
  OPTICAL_RECEIVER_SETTINGS_KEY,
  OPTICAL_SENDER_SETTINGS_KEY,
  saveOpticalReceiverSettings,
  saveOpticalSenderSettings,
  type OpticalReceiverSettings,
  type OpticalTransferSettings,
} from "../optical/shared/settings.js"

const senderDefaults: OpticalTransferSettings = {
  txFps: 30,
  frameBytes: 2953,
  ecc: "L",
  gridCodes: 4,
}

const receiverDefaults: OpticalReceiverSettings = {
  cameraId: "",
  captureWidth: 1280,
  captureFps: 60,
  iso: 200,
  workers: 3,
}

const receiverOptions = {
  captureWidths: [960, 1280, 1920],
  captureFps: [30, 60],
  workers: [1, 2, 3, 4],
}

beforeEach(() => localStorage.clear())

describe("optical setting persistence", () => {
  it("offers frame sizes up to each v48 ECC capacity", () => {
    expect(FRAME_BYTES_OPTIONS).toEqual([500, 1000, 1450, 1850, 2331, 2953, 4143])
    expect(frameBytesOptionsForEcc("L")).toContain(4143)
    expect(frameBytesOptionsForEcc("M")).toContain(2953)
    expect(frameBytesOptionsForEcc("Q")).toContain(2331)
    expect(frameBytesOptionsForEcc("H")).toEqual([500, 1000, 1450])
  })

  it("restores valid sender settings over Wrangler defaults", () => {
    const saved: OpticalTransferSettings = { txFps: 24, frameBytes: 1450, ecc: "Q", gridCodes: 2 }
    saveOpticalSenderSettings(saved)

    expect(loadOpticalSenderSettings(senderDefaults)).toEqual(saved)
    expect(JSON.parse(localStorage.getItem(OPTICAL_SENDER_SETTINGS_KEY)!)).toEqual({ version: 1, ...saved })
  })

  it("falls back field by field for malformed or unsupported sender values", () => {
    localStorage.setItem(
      OPTICAL_SENDER_SETTINGS_KEY,
      JSON.stringify({ version: 1, txFps: 999, frameBytes: 1000, ecc: "Z", gridCodes: 9 }),
    )

    expect(loadOpticalSenderSettings(senderDefaults)).toEqual({
      txFps: senderDefaults.txFps,
      frameBytes: 1000,
      ecc: senderDefaults.ecc,
      gridCodes: 9,
    })
  })

  it("normalizes a stored frame size that the selected ECC cannot encode", () => {
    localStorage.setItem(
      OPTICAL_SENDER_SETTINGS_KEY,
      JSON.stringify({ version: 1, txFps: 30, frameBytes: 2953, ecc: "H", gridCodes: 4 }),
    )

    expect(loadOpticalSenderSettings(senderDefaults)).toMatchObject({ frameBytes: 1450, ecc: "H" })
  })

  it("restores receiver settings only when this page/device still offers them", () => {
    saveOpticalReceiverSettings({
      cameraId: "rear-wide",
      captureWidth: 1920,
      captureFps: 30,
      iso: 390,
      workers: 4,
    })

    expect(loadOpticalReceiverSettings(receiverDefaults, receiverOptions)).toEqual({
      cameraId: "rear-wide",
      captureWidth: 1920,
      captureFps: 30,
      iso: 390,
      workers: 4,
    })

    const reducedDevice = { ...receiverOptions, captureWidths: [960, 1280], workers: [1, 2] }
    expect(loadOpticalReceiverSettings(receiverDefaults, reducedDevice)).toEqual({
      cameraId: "rear-wide",
      captureWidth: receiverDefaults.captureWidth,
      captureFps: 30,
      iso: 390,
      workers: receiverDefaults.workers,
    })
    expect(JSON.parse(localStorage.getItem(OPTICAL_RECEIVER_SETTINGS_KEY)!)).toMatchObject({ version: 1 })
  })

  it("keeps ISO as a device-independent preference and rejects invalid values", () => {
    localStorage.setItem(
      OPTICAL_RECEIVER_SETTINGS_KEY,
      JSON.stringify({ version: 1, iso: 6400, isoRange: { min: 100, max: 200, step: 10 } }),
    )
    expect(loadOpticalReceiverSettings(receiverDefaults, receiverOptions).iso).toBe(6400)

    localStorage.setItem(OPTICAL_RECEIVER_SETTINGS_KEY, JSON.stringify({ version: 1, iso: -1 }))
    expect(loadOpticalReceiverSettings(receiverDefaults, receiverOptions).iso).toBe(receiverDefaults.iso)
  })

  it("ignores obsolete, corrupted, and unavailable storage without breaking startup", () => {
    localStorage.setItem(OPTICAL_SENDER_SETTINGS_KEY, JSON.stringify({ version: 0, txFps: 24 }))
    expect(loadOpticalSenderSettings(senderDefaults)).toEqual(senderDefaults)

    localStorage.setItem(OPTICAL_SENDER_SETTINGS_KEY, "not-json")
    expect(loadOpticalSenderSettings(senderDefaults)).toEqual(senderDefaults)

    const unavailable = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError")
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError")
      },
    }
    expect(loadOpticalSenderSettings(senderDefaults, unavailable)).toEqual(senderDefaults)
    expect(() => saveOpticalSenderSettings(senderDefaults, unavailable)).not.toThrow()
  })
})
