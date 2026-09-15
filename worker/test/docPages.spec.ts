import { describe, expect, it } from "vitest"
import { createExecutionContext } from "cloudflare:test"

import { BASE_URL, workerFetch } from "./testUtils.js"
import { TEXT_MIME_TYPE } from "../../shared/constants.js"
import { handleStaticPages } from "../handlers/staticPages.js"

const curlHeaders = { "User-Agent": "curl/8.0.0" }
const browserHeaders = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

describe("doc pages", () => {
  const ctx = createExecutionContext()

  it("returns rendered HTML to browsers", async () => {
    for (const page of ["/doc/api", "/doc/tos", "/doc/curl", "/doc/skill"]) {
      const resp = await workerFetch(ctx, new Request(`${BASE_URL}${page}`, { headers: browserHeaders }))
      expect(resp.status, `visiting ${page}`).toStrictEqual(200)
      expect(resp.headers.get("Content-Type")).toStrictEqual("text/html;charset=UTF-8")
      const body = await resp.text()
      expect(body.startsWith("<!DOCTYPE html>"), `body of ${page} should be HTML`).toStrictEqual(true)
    }
  })

  it("returns raw markdown to curl", async () => {
    for (const page of ["/doc/api", "/doc/tos", "/doc/curl", "/doc/skill"]) {
      const resp = await workerFetch(ctx, new Request(`${BASE_URL}${page}`, { headers: curlHeaders }))
      expect(resp.status, `visiting ${page}`).toStrictEqual(200)
      expect(resp.headers.get("Content-Type")).toStrictEqual(TEXT_MIME_TYPE)
      expect(resp.headers.get("Vary")).toStrictEqual("User-Agent")
      const body = await resp.text()
      expect(body.startsWith("<!DOCTYPE html>"), `body of ${page} should be markdown`).toStrictEqual(false)
    }
  })

  it("returns 404 for unknown doc paths", async () => {
    for (const page of ["/doc", "/doc/", "/doc/missing", "/doc/cli", "/doc/missing.md"]) {
      const resp = await workerFetch(ctx, `${BASE_URL}${page}`)
      expect(resp.status, `visiting ${page}`).toStrictEqual(404)
      await resp.body?.cancel()
    }
  })

  it("serves markdown to any UA on /doc/<name>.md", async () => {
    for (const page of ["/doc/api.md", "/doc/tos.md", "/doc/curl.md", "/doc/skill.md"]) {
      const resp = await workerFetch(ctx, new Request(`${BASE_URL}${page}`, { headers: browserHeaders }))
      expect(resp.status, `visiting ${page}`).toStrictEqual(200)
      expect(resp.headers.get("Content-Type")).toStrictEqual(TEXT_MIME_TYPE)
      const body = await resp.text()
      expect(body.startsWith("<!DOCTYPE html>"), `body of ${page} should be markdown`).toStrictEqual(false)
    }
  })

  it("serves /index.md as markdown to any UA", async () => {
    const resp = await workerFetch(ctx, new Request(`${BASE_URL}/index.md`, { headers: browserHeaders }))
    expect(resp.status).toStrictEqual(200)
    expect(resp.headers.get("Content-Type")).toStrictEqual(TEXT_MIME_TYPE)
    const body = await resp.text()
    expect(body.includes("# Pastebin Worker")).toStrictEqual(true)
    expect(body.includes("{{BASE_URL}}")).toStrictEqual(false)
  })

  it("expands {{BASE_URL}} in doc bodies", async () => {
    const resp = await workerFetch(ctx, new Request(`${BASE_URL}/doc/curl`, { headers: curlHeaders }))
    const body = await resp.text()
    expect(body.includes("{{BASE_URL}}"), "template should be expanded").toStrictEqual(false)
    expect(body.includes(BASE_URL), "should contain DEPLOY_URL").toStrictEqual(true)
  })

  it("serves doc/index.md as markdown to curl on /", async () => {
    const resp = await workerFetch(ctx, new Request(BASE_URL, { headers: curlHeaders }))
    expect(resp.status).toStrictEqual(200)
    expect(resp.headers.get("Content-Type")).toStrictEqual(TEXT_MIME_TYPE)
    expect(resp.headers.get("Vary")).toStrictEqual("User-Agent")
    const body = await resp.text()
    expect(body.includes("# Pastebin Worker"), "body should contain index heading").toStrictEqual(true)
    expect(body.includes("{{BASE_URL}}"), "template should be expanded").toStrictEqual(false)
  })

  it("serves the SPA to browsers on /", async () => {
    const resp = await workerFetch(ctx, new Request(BASE_URL, { headers: browserHeaders }))
    expect(resp.status).toStrictEqual(200)
    expect(resp.headers.get("Content-Type")).toStrictEqual("text/html;charset=UTF-8")
    expect(resp.headers.get("Cross-Origin-Opener-Policy")).toStrictEqual("same-origin")
    expect(resp.headers.get("Cross-Origin-Embedder-Policy")).toStrictEqual("require-corp")
  })

  it("allows workers created by the isolated SPA to inherit COEP", async () => {
    const env = {
      ASSETS: { fetch: () => Promise.resolve(new Response("export {}")) },
      CACHE_STATIC_PAGE_AGE: 0,
    } as unknown as Env
    const resp = await handleStaticPages(new Request(`${BASE_URL}/assets/generated-worker.js`), env)

    expect(resp?.status).toStrictEqual(200)
    expect(resp?.headers.get("Cross-Origin-Embedder-Policy")).toStrictEqual("require-corp")
  })

  it("serves the QR camera receiver at its fixed URL", async () => {
    for (const page of ["/qr-receiver", "/qr-receiver/"]) {
      const resp = await workerFetch(ctx, new Request(`${BASE_URL}${page}`, { headers: browserHeaders }))
      expect(resp.status, `visiting ${page}`).toStrictEqual(200)
      expect(resp.headers.get("Content-Type")).toStrictEqual("text/html;charset=UTF-8")
      const body = await resp.text()
      expect(body).toContain('<div id="root"></div>')
      expect(body).toContain('type="module"')
    }
  })
})
