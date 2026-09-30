import { useEffect } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { getInitialPasteState, usePasteLoader } from "../utils/usePasteLoader.js"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete window.__PASTE_DATA__
})

it.each([false, true])("restarts after StrictMode cleanup and loads the body (read limited: %s)", async (limited) => {
  const headSignals: AbortSignal[] = []
  let bodyRequests = 0
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const signal = init!.signal!
    signal.throwIfAborted()
    if (init?.method === "HEAD") {
      headSignals.push(signal)
      if (headSignals.length === 1) {
        return await new Promise<Response>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        })
      }
      return new Response(null, {
        headers: {
          "Content-Length": "5",
          "Content-Type": "text/plain",
          ...(limited ? { "X-PB-Remaining-Reads": "1" } : {}),
        },
      })
    }
    if (typeof input === "string" && input.startsWith("/m/")) {
      return Response.json({
        sizeBytes: 5,
        location: "KV",
        createdAt: "",
        lastModifiedAt: "",
        expireAt: "",
      })
    }
    bodyRequests += 1
    return new Response("hello", {
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": 'inline; filename="hello.txt"',
        ...(limited ? { "X-PB-Remaining-Reads": "1" } : {}),
      },
    })
  })
  const url = new URL("https://example.test/d/abcd")
  const onReadConsumed = vi.fn()
  const showError = vi.fn()
  const handleFailedResponse = vi.fn()
  const { result, rerender, unmount } = renderHook(
    () => {
      const paste = usePasteLoader({
        url,
        name: "abcd",
        enabled: true,
        initialState: getInitialPasteState(url, "abcd", undefined, undefined),
        onReadConsumed,
        showError,
        handleFailedResponse,
      })
      // DisplayPaste also disposes the loader in its pagehide effect cleanup.
      useEffect(() => paste.dispose, [paste.dispose])
      return paste
    },
    { reactStrictMode: true },
  )
  if (limited) {
    await waitFor(() => expect(result.current.pendingInfo?.isReadLimited).toBe(true))
    expect(bodyRequests).toBe(0)
    await act(async () => result.current.loadBody())
  }
  await waitFor(() => expect(result.current.pasteText).toBe("hello"))
  expect(result.current.isLoading).toBe(false)
  expect(headSignals).toHaveLength(2)
  expect(headSignals[0].aborted).toBe(true)
  expect(headSignals[1].aborted).toBe(false)
  expect(bodyRequests).toBe(1)
  expect(onReadConsumed).toHaveBeenCalledTimes(1)
  expect(showError).not.toHaveBeenCalled()
  expect(handleFailedResponse).not.toHaveBeenCalled()
  const dispose = result.current.dispose
  const requests = fetchMock.mock.calls.length
  rerender()
  expect(result.current.dispose).toBe(dispose)
  expect(fetchMock).toHaveBeenCalledTimes(requests)
  unmount()
  expect(headSignals[1].aborted).toBe(true)
})

it("starts when an initially disabled loader becomes enabled", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, {
      headers: { "Content-Length": "20000000", "Content-Type": "application/octet-stream" },
    }),
  )
  const url = new URL("https://example.test/d/abcd")
  const { result, rerender } = renderHook(
    ({ enabled }) =>
      usePasteLoader({
        url,
        name: "abcd",
        enabled,
        initialState: getInitialPasteState(url, "abcd", undefined, undefined),
        onReadConsumed: vi.fn(),
        showError: vi.fn(),
        handleFailedResponse: vi.fn(),
      }),
    { initialProps: { enabled: false } },
  )
  expect(fetch).not.toHaveBeenCalled()
  rerender({ enabled: true })
  await waitFor(() => expect(result.current.pendingInfo?.sizeBytes).toBe(20000000))
  expect(result.current.isLoading).toBe(false)
})
