import { describe, expect, it, vi } from "vitest"
import { createExecutionContext } from "cloudflare:test"
import { BASE_URL, workerFetch } from "./testUtils.js"

describe("upload form body limits", () => {
  it("rejects a combined form above the limit even when each part fits", async () => {
    const form = new FormData()
    const part = new Blob([new Uint8Array(3 * 1024 * 1024)])
    form.append("ignored", part, "ignored.bin")
    form.append("c", part, "paste.bin")
    const response = await workerFetch(createExecutionContext(), new Request(BASE_URL, { method: "POST", body: form }))
    expect(response.status).toBe(413)
    expect(await response.text()).toContain("request body is too large")
  })

  it.each([undefined, "1"])("bounds streamed input with Content-Length %s and cancels unread bytes", async (length) => {
    const chunk = new Uint8Array(1024 * 1024)
    const cancel = vi.fn()
    let reads = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++
          controller.enqueue(chunk)
          if (reads === 30) controller.close()
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const headers = new Headers({ "Content-Type": "multipart/form-data; boundary=limit-test" })
    if (length) headers.set("Content-Length", length)
    const response = await workerFetch(
      createExecutionContext(),
      new Request(BASE_URL, { method: "POST", headers, body: stream }),
    )
    expect(response.status).toBe(413)
    await response.text()
    expect(reads).toBeLessThanOrEqual(8)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects a declared oversized body without reading it", async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const response = await workerFetch(
      createExecutionContext(),
      new Request(BASE_URL, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "multipart/form-data; boundary=limit-test",
          "Content-Length": String(7 * 1024 * 1024),
        },
      }),
    )
    expect(response.status).toBe(413)
    await response.text()
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("uses a small body limit for MPU completion independently of the file limit", async () => {
    const form = new FormData()
    form.set("c", new File([new Uint8Array(3 * 1024 * 1024)], "parts.json"))
    const response = await workerFetch(
      createExecutionContext(),
      new Request(`${BASE_URL}/mpu/complete?name=x&key=x&uploadId=x`, { method: "POST", body: form }),
    )
    expect(response.status).toBe(413)
    await response.text()
  })
})
