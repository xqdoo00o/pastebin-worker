import { StrictMode } from "react"
import { cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useObjectUrl } from "../utils/useObjectUrl.js"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("keeps only the current Blob URL alive across StrictMode, replacement and removal", () => {
  const active = new Set<string>()
  let sequence = 0
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        const url = `blob:test-${sequence++}`
        active.add(url)
        return url
      }
      static revokeObjectURL(url: string) {
        active.delete(url)
      }
    },
  )
  const { result, rerender, unmount } = renderHook<string, { blob: Blob | undefined }>(
    ({ blob }) => useObjectUrl(blob),
    { initialProps: { blob: new Blob(["first"]) }, wrapper: StrictMode },
  )
  expect([...active]).toEqual([result.current])
  const firstUrl = result.current
  rerender({ blob: new Blob(["second"]) })
  expect(result.current).not.toBe(firstUrl)
  expect([...active]).toEqual([result.current])
  rerender({ blob: undefined })
  expect(result.current).toBe("")
  expect(active.size).toBe(0)
  rerender({ blob: new Blob(["third"]) })
  expect([...active]).toEqual([result.current])
  unmount()
  expect(active.size).toBe(0)
})
