import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

const origin = "https://paste.example"
const homeHtml = '<script type="module" src="/assets/home-test.js"></script>'
const template = readFileSync(new URL("../../frontend/pwa/service-worker.js", import.meta.url), "utf8")

type FetchRequest = Pick<Request, "url" | "method" | "mode" | "headers">
interface WorkerEvent {
  request?: FetchRequest
  waitUntil: (work: Promise<unknown>) => void
  respondWith: (response: Promise<Response>) => void
}

function workerHarness() {
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  const stored = new Map<string, Response>()
  const cacheKey = (request: string | FetchRequest) =>
    new URL(typeof request === "string" ? request : request.url, origin).href
  const cache = {
    addAll: vi.fn(() => Promise.resolve()),
    put: vi.fn((request: string | FetchRequest, response: Response) => {
      stored.set(cacheKey(request), response.clone())
      return Promise.resolve()
    }),
    match: vi.fn((request: string | FetchRequest) => Promise.resolve(stored.get(cacheKey(request))?.clone())),
    delete: vi.fn((request: string | FetchRequest) => Promise.resolve(stored.delete(cacheKey(request)))),
  }
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(homeHtml, { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=7200" } }),
    ),
  )
  const caches = {
    open: vi.fn(() => Promise.resolve(cache)),
    keys: vi.fn(() => Promise.resolve(["unrelated-app", "pastebin-pwa-old", "pastebin-pwa-test"])),
    delete: vi.fn(() => Promise.resolve(true)),
  }
  class RelativeRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, origin) : input, init)
    }
  }
  const clients = { claim: vi.fn(() => Promise.resolve()) }
  const skipWaiting = vi.fn()
  runInNewContext(
    template
      .replace("__PWA_VERSION__", "test")
      .replace("__PWA_ENTRY__", "/assets/home-test.js")
      .replace("/* PWA_ASSETS */ []", '["/assets/home-test.js", "/assets/codec-test.wasm"]')
      .replace("/* PWA_PRECACHE */ []", '["/assets/home-test.js"]'),
    {
      self: {
        location: { origin },
        clients,
        skipWaiting,
        addEventListener: (name: string, listener: (event: WorkerEvent) => void) => listeners.set(name, listener),
      },
      caches,
      fetch,
      URL,
      Request: RelativeRequest,
    },
  )
  async function dispatch(name: string, request?: FetchRequest) {
    const pending: Promise<unknown>[] = []
    let response: Promise<Response> | undefined
    listeners.get(name)!({
      request,
      waitUntil: (work) => {
        pending.push(work)
      },
      respondWith: (work) => {
        response = work
      },
    })
    const result = response ? await response : undefined
    await Promise.all(pending)
    return result
  }
  const request = (
    path: string,
    mode: RequestMode = "navigate",
    method = "GET",
    headers = new Headers(),
  ): FetchRequest => ({ url: new URL(path, origin).href, method, mode, headers })
  return { cache, caches, clients, skipWaiting, fetch, dispatch, request }
}

describe("PWA cache boundaries", () => {
  it("precaches only core assets and a public shell, then opens that shell offline", async () => {
    const sw = workerHarness()
    await sw.dispatch("install")
    expect(sw.cache.addAll).toHaveBeenCalledWith([
      expect.objectContaining({ url: `${origin}/assets/home-test.js`, cache: "reload" }),
    ])
    sw.fetch.mockRejectedValue(new TypeError("offline"))
    for (const path of ["/", "/index", "/index.html"]) {
      expect(await (await sw.dispatch("fetch", sw.request(path)))?.text()).toBe(homeHtml)
    }
  })

  it("refreshes the homepage online and keeps HTML paired with the controlling worker's JS", async () => {
    const sw = workerHarness()
    await sw.dispatch("install")
    const newerHtml = homeHtml.replace("home-test.js", "home-new.js")
    sw.fetch.mockResolvedValue(new Response(newerHtml, { headers: { "Content-Type": "text/html" } }))
    expect(await (await sw.dispatch("fetch", sw.request("/")))?.text()).toBe(newerHtml)
    expect(sw.fetch).toHaveBeenLastCalledWith(sw.request("/"), { cache: "no-cache" })
    sw.fetch.mockRejectedValue(new TypeError("offline"))
    expect(await (await sw.dispatch("fetch", sw.request("/")))?.text()).toBe(homeHtml)
  })

  it.each(["private, no-store", "no-store", "private"])(
    "does not retain protected homepage responses (%s)",
    async (policy) => {
      const sw = workerHarness()
      await sw.dispatch("install")
      sw.fetch.mockResolvedValue(
        new Response(homeHtml, { headers: { "Content-Type": "text/html", "Cache-Control": policy } }),
      )
      await sw.dispatch("fetch", sw.request("/"))
      expect(await sw.cache.match("/")).toBeUndefined()
      sw.fetch.mockRejectedValue(new TypeError("offline"))
      await expect(sw.dispatch("fetch", sw.request("/"))).rejects.toThrow("offline")
    },
  )

  it("returns authentication failures without replaying an old cached homepage", async () => {
    const sw = workerHarness()
    await sw.dispatch("install")
    sw.fetch.mockResolvedValue(new Response("Unauthorized", { status: 401 }))
    expect((await sw.dispatch("fetch", sw.request("/")))?.status).toBe(401)
    expect(await sw.cache.match("/")).toBeUndefined()
  })

  it.each([
    "/abcd",
    "/d/abcd",
    "/m/abcd",
    "/abcd:secret",
    "/p2p/abcd",
    "/doc/api",
    "/?password=secret",
    "https://other.example/assets/home-test.js",
    "/assets/unlisted.js",
  ])("leaves %s to the network", async (path) => {
    const sw = workerHarness()
    expect(await sw.dispatch("fetch", sw.request(path))).toBeUndefined()
    expect(sw.fetch).not.toHaveBeenCalled()
    expect(sw.cache.put).not.toHaveBeenCalled()
  })

  it("does not intercept mutations or range requests", async () => {
    const sw = workerHarness()
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      expect(await sw.dispatch("fetch", sw.request("/", "navigate", method))).toBeUndefined()
    }
    expect(
      await sw.dispatch(
        "fetch",
        sw.request("/assets/codec-test.wasm", "cors", "GET", new Headers({ Range: "bytes=0-10" })),
      ),
    ).toBeUndefined()
  })

  it("caches lazily loaded codec assets and serves them offline", async () => {
    const sw = workerHarness()
    sw.fetch.mockResolvedValue(new Response("wasm"))
    const request = sw.request("/assets/codec-test.wasm", "cors")
    expect(await (await sw.dispatch("fetch", request))?.text()).toBe("wasm")
    sw.fetch.mockRejectedValue(new TypeError("offline"))
    expect(await (await sw.dispatch("fetch", request))?.text()).toBe("wasm")
  })

  it.each(["open", "match"] as const)("keeps online requests working when cache %s fails", async (method) => {
    const sw = workerHarness()
    if (method === "open") sw.caches.open.mockRejectedValue(new Error("storage unavailable"))
    else sw.cache.match.mockRejectedValue(new Error("storage unavailable"))
    for (const request of [sw.request("/"), sw.request("/assets/home-test.js", "cors")]) {
      expect(await (await sw.dispatch("fetch", request))?.text()).toBe(homeHtml)
    }
    expect(sw.fetch).toHaveBeenCalledTimes(2)
  })

  it("does not cache incomplete static responses", async () => {
    const sw = workerHarness()
    sw.fetch.mockResolvedValue(new Response("partial", { status: 206 }))
    expect((await sw.dispatch("fetch", sw.request("/assets/home-test.js", "cors")))?.status).toBe(206)
    expect(sw.cache.put).not.toHaveBeenCalled()
  })

  it("waits for existing clients before updating and deletes only this app's obsolete caches", async () => {
    const sw = workerHarness()
    await sw.dispatch("install")
    expect(sw.skipWaiting).not.toHaveBeenCalled()
    await sw.dispatch("activate")
    expect(sw.caches.delete).toHaveBeenCalledExactlyOnceWith("pastebin-pwa-old")
    expect(sw.clients.claim).toHaveBeenCalledOnce()
  })
})
