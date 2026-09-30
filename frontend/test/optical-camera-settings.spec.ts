import { afterEach, describe, expect, it, vi } from "vitest"
import { CameraSettingsScheduler, type CameraSettingsChange } from "../optical/receive/camera.js"

afterEach(() => vi.useRealTimers())

describe("live camera settings", () => {
  it("coalesces ISO changes and lets mode changes preempt the throttle", async () => {
    vi.useFakeTimers()
    const apply = vi.fn((_kind: CameraSettingsChange) => Promise.resolve())
    const persist = vi.fn()
    const scheduler = new CameraSettingsScheduler(apply, persist, vi.fn())
    scheduler.schedule("exposure")
    await vi.advanceTimersByTimeAsync(60)
    scheduler.schedule("exposure")
    expect(apply).not.toHaveBeenCalled()
    scheduler.schedule("mode")
    await vi.advanceTimersByTimeAsync(0)
    expect(apply.mock.calls).toEqual([["mode"]])
    expect(persist).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(120)
    expect(apply).toHaveBeenCalledOnce()
  })

  it("serializes constraints and applies only the latest ISO after an in-flight change", async () => {
    vi.useFakeTimers()
    let release!: () => void
    let iso = 100
    const seen: number[] = []
    const apply = vi.fn(async () => {
      seen.push(iso)
      if (seen.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
    })
    const scheduler = new CameraSettingsScheduler(apply, vi.fn(), vi.fn())
    scheduler.schedule("exposure")
    await vi.advanceTimersByTimeAsync(120)
    iso = 200
    scheduler.schedule("exposure")
    iso = 300
    scheduler.schedule("exposure")
    await vi.advanceTimersByTimeAsync(120)
    expect(seen).toEqual([100])
    release()
    await vi.runAllTimersAsync()
    expect(seen).toEqual([100, 300])
  })

  it("cancels pending work on stop or camera switch and persists the last choice once", async () => {
    vi.useFakeTimers()
    let release!: () => void
    const apply = vi.fn(
      (_kind: CameraSettingsChange) =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const persist = vi.fn()
    const scheduler = new CameraSettingsScheduler(apply, persist, vi.fn())
    scheduler.schedule("mode")
    await vi.advanceTimersByTimeAsync(0)
    scheduler.schedule("exposure")
    scheduler.cancel()
    scheduler.cancel()
    expect(persist).toHaveBeenCalledOnce()
    release()
    await vi.runAllTimersAsync()
    expect(apply.mock.calls).toEqual([["mode"]])

    scheduler.schedule("exposure")
    scheduler.cancel()
    await vi.runAllTimersAsync()
    expect(apply).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledTimes(2)

    scheduler.schedule("mode")
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(2)
    release()
    await vi.runAllTimersAsync()
  })

  it("allows another change after a failed application", async () => {
    vi.useFakeTimers()
    const error = new Error("camera disconnected")
    const apply = vi.fn(() => Promise.resolve()).mockRejectedValueOnce(error)
    const onError = vi.fn()
    const scheduler = new CameraSettingsScheduler(apply, vi.fn(), onError)
    scheduler.schedule("mode")
    await vi.runAllTimersAsync()
    expect(onError).toHaveBeenCalledWith(error)
    scheduler.schedule("exposure")
    await vi.runAllTimersAsync()
    expect(apply).toHaveBeenCalledTimes(2)
  })
})
