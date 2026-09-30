import { createExecutionContext } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { BASE_URL, workerFetch } from "./testUtils.js"

describe("PWA homepage and resources", () => {
  const ctx = createExecutionContext()
  it.each(["/", "/index", "/index.html", "/abcd:secret"])("links the PWA manifest in %s", async (path) => {
    const response = await workerFetch(ctx, `${BASE_URL}${path}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  })

  it("serves an installable manifest using the configured site name", async () => {
    const response = await workerFetch(ctx, `${BASE_URL}/manifest.webmanifest`)
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("application/manifest+json")
    expect(response.headers.get("Cache-Control")).toBe("no-cache")
    expect(await response.json()).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      icons: [
        { sizes: "192x192", type: "image/png" },
        { sizes: "512x512", type: "image/png" },
      ],
    })
  })

  it("serves a root-scoped worker that revalidates and opts into COEP", async () => {
    const response = await workerFetch(ctx, `${BASE_URL}/sw.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toMatch(/javascript/)
    expect(response.headers.get("Cache-Control")).toBe("no-cache")
    expect(response.headers.get("Service-Worker-Allowed")).toBe("/")
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp")
    const script = await response.text()
    expect(script).not.toContain("__PWA_")
    expect(script).toContain("pastebin-pwa-")
  })

  it.each(["icon-192.png", "icon-512.png", "apple-touch-icon.png"])("serves %s as an image", async (name) => {
    const response = await workerFetch(ctx, `${BASE_URL}/pwa/${name}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("image/png")
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100)
  })
})
