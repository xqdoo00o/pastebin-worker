import { afterEach, describe, expect, it, vi } from "vitest"
import {
  NO_READABLE_APNG_QR_MESSAGE,
  OpticalReceiverRuntime,
  ReceivedFileResource,
  ReceiverSession,
} from "../optical/receive/receiver-runtime.js"

const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL ?? { configurable: true, value: undefined })
})

describe("optical receiver runtime", () => {
  it("tracks stream identity, elapsed time, APNG progress and timer cleanup", () => {
    vi.useFakeTimers()
    const runtime = new OpticalReceiverRuntime()
    const snapshot = { identity: "stream-1" } as never
    expect(runtime.applySnapshot(snapshot, false, 1_000)).toBe(true)
    expect(runtime.applySnapshot(snapshot, false, 2_000)).toBe(false)
    expect(runtime.elapsed(3_500)).toBe(2.5)

    runtime.noteApngFrame(12)
    expect([runtime.apngFrameNumber, runtime.apngFrameTotal]).toEqual([1, 12])

    const update = vi.fn()
    runtime.startUpdateTimer(update)
    vi.advanceTimersByTime(1_000)
    expect(update).toHaveBeenCalledTimes(2)
    runtime.stopUpdateTimer()
    vi.advanceTimersByTime(1_000)
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("rejects an APNG immediately when its first frame contains no readable QR symbols", () => {
    const runtime = new OpticalReceiverRuntime()
    const reject = vi.fn<(error: Error) => void>()
    runtime.setApngAttemptRejector(reject)

    expect(runtime.rejectUnreadableFirstApngFrame(1, 0)).toBe(false)
    expect(runtime.rejectUnreadableFirstApngFrame(0, 1)).toBe(false)
    expect(runtime.rejectUnreadableFirstApngFrame(0, 0)).toBe(true)
    expect(reject).toHaveBeenCalledOnce()
    expect(reject.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(reject.mock.calls[0][0].message).toBe(NO_READABLE_APNG_QR_MESSAGE)
  })
})

describe("optical received-file resource", () => {
  it("deletes an undownloaded temporary file", async () => {
    const cleanup = vi.fn(() => Promise.resolve())
    const deferCleanup = vi.fn()
    const resource = new ReceivedFileResource()
    resource.setStoredFile({ cleanup, deferCleanup })
    resource.release()
    await Promise.resolve()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(deferCleanup).not.toHaveBeenCalled()
  })

  it("defers cleanup after the browser has started downloading", () => {
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
    const cleanup = vi.fn(() => Promise.resolve())
    const deferCleanup = vi.fn()
    const resource = new ReceivedFileResource()
    resource.setStoredFile({ cleanup, deferCleanup })
    resource.markDownloadStarted()

    resource.release()
    expect(deferCleanup).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
  })
})

describe("receiver session", () => {
  it("tracks delivery independently for each capture attempt", () => {
    const session = new ReceiverSession("camera")
    const first = session.beginAttempt()
    session.markDelivered()
    expect(session.attemptDelivered).toBe(true)
    expect(session.isCurrent("camera", first)).toBe(true)

    const second = session.beginAttempt()
    expect(session.attemptDelivered).toBe(false)
    expect(session.isCurrent("camera", first)).toBe(false)
    expect(session.isCurrent("camera", second)).toBe(true)
  })

  it("makes mode transitions atomic and runs every teardown hook", async () => {
    const session = new ReceiverSession<"camera" | "screen">("camera")
    const generation = session.beginAttempt()
    const released: string[] = []
    session.addTeardown(() => {
      released.push("stream")
    })
    session.addTeardown(async () => {
      await Promise.resolve()
      released.push("worker")
    })

    const screenTransition = session.beginModeTransition("screen")
    expect(session.mode).toBe("screen")
    expect(session.isCurrentTransition(screenTransition)).toBe(true)
    expect(session.isCurrent("camera", generation)).toBe(false)

    const cameraTransition = session.beginModeTransition("camera")
    expect(session.mode).toBe("camera")
    expect(session.isCurrentTransition(screenTransition)).toBe(false)
    expect(session.isCurrentTransition(cameraTransition)).toBe(true)
    await session.teardown()
    expect(released.sort()).toEqual(["stream", "worker"])
  })
})
