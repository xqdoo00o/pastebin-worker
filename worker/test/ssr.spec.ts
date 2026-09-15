import { test, expect, describe } from "vitest"
import { workerFetch, upload, BASE_URL } from "./testUtils.js"
import { createExecutionContext } from "cloudflare:test"

describe("SSR Display Page", () => {
  const ctx = createExecutionContext()

  test("should render display page HTML", async () => {
    // Upload a test paste
    const content = "Hello SSR World"
    const uploadResp = await upload(ctx, { c: content })
    const name = new URL(uploadResp.url).pathname.slice(1)

    // Fetch display page
    const resp = await workerFetch(ctx, `${BASE_URL}/d/${name}`)
    expect(resp.status).toBe(200)
    expect(resp.headers.get("Content-Type")).toContain("text/html")

    const html = await resp.text()

    // Should contain valid HTML structure
    expect(html).toContain("<!doctype html>")
    expect(html.includes("\u0000")).toStrictEqual(false)
    expect(html).toContain('<div id="root">')
    expect(html).toContain(name) // Title should contain paste name

    const hasSerializedData = html.includes("__PASTE_DATA__")
    expect(hasSerializedData).toBe(true)
    expect(html).toContain("application/json")
    expect(html).toContain("window.__PASTE_DATA__")

    const match = /<script id="__PASTE_DATA__" type="application\/json">(.*?)<\/script>/.exec(html)
    expect(match).toBeTruthy()

    const data = JSON.parse(match![1]) as { name: string; content: string; metadata: unknown }
    expect(data.name).toBe(name)
    expect(data.content).toBeTruthy()
    expect(data.metadata).toBeTruthy()
  })

  test("serializes the effective MIME type for an SSR media file", async () => {
    const uploadResp = await upload(ctx, {
      c: { content: new Blob(["ID3"]), filename: "song.mp3" },
    })
    const name = new URL(uploadResp.url).pathname.slice(1)

    const resp = await workerFetch(ctx, `${BASE_URL}/d/${name}`)
    const html = await resp.text()
    const match = /<script id="__PASTE_DATA__" type="application\/json">(.*?)<\/script>/.exec(html)
    const data = JSON.parse(match![1]) as { contentType: string }

    expect(data.contentType).toBe("audio/mpeg")
  })
})
