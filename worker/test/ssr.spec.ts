import { test, expect, describe } from "vitest"
import { workerFetch, upload, BASE_URL } from "./testUtils.js"
import { createExecutionContext } from "cloudflare:test"
import { getAssetPaths } from "../ssrUtils.js"

describe("SSR Display Page", () => {
  const ctx = createExecutionContext()

  test("rejects a missing asset manifest entry instead of rendering guessed resource paths", () => {
    expect(() => getAssetPaths({}, "display.html")).toThrow("Frontend manifest is missing entry: display.html")
  })

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

  test("escapes a URL filename in the client-rendered display shell", async () => {
    const paste = await upload(ctx, { c: "limited", reads: "1" })
    const name = new URL(paste.url).pathname.slice(1)
    const injectedFilename = "</title><script>alert(1)</script>"
    const response = await workerFetch(ctx, `${BASE_URL}/d/${name}/${encodeURIComponent(injectedFilename)}`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain(injectedFilename)
  })
})
