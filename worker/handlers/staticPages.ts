import mime from "mime"

import { OPTICAL_RECEIVER_PATH, TEXT_MIME_TYPE } from "../../shared/constants.js"
import manifest from "../../dist/frontend/.vite/ssr-manifest.json"
import { WorkerError } from "../common.js"
import { verifyAuth } from "../pages/auth.js"
import { getCurlIndexMarkdown, getDocMarkdown, renderDocAsHtml } from "../pages/docs.js"
import { publicEnv, renderReactDocument } from "../ssrUtils.js"

type CacheHeaders = Record<string, string>

const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const

function staticPageCacheHeader(env: Env): CacheHeaders {
  const age = env.CACHE_STATIC_PAGE_AGE
  return age ? { "Cache-Control": `public, max-age=${age}` } : {}
}

function protectedPageCacheHeader(env: Env): CacheHeaders {
  const basicAuth = env.BASIC_AUTH as Record<string, string>
  return Object.keys(basicAuth).length > 0 ? { "Cache-Control": "private, no-store" } : staticPageCacheHeader(env)
}

function isCurlAgent(request: Request): boolean {
  return (request.headers.get("User-Agent") || "").toLowerCase().startsWith("curl/")
}

export async function handleStaticPages(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const isCurl = isCurlAgent(request)

  if (url.pathname === OPTICAL_RECEIVER_PATH || url.pathname === `${OPTICAL_RECEIVER_PATH}/`) {
    const pageUrl = new URL("/optical-receive.html", env.DEPLOY_URL)
    const page = await env.ASSETS.fetch(pageUrl)
    if (!page.ok) throw new WorkerError(500, "QR camera receiver page is unavailable")
    return new Response(request.method === "HEAD" ? null : page.body, {
      headers: { "Content-Type": "text/html;charset=UTF-8", ...staticPageCacheHeader(env) },
    })
  }

  if ((url.pathname === "/" && isCurl) || url.pathname === "/index.md") {
    const authResponse = await verifyAuth(request, env)
    if (authResponse !== null) return authResponse
    return new Response(getCurlIndexMarkdown(env), {
      headers: { "Content-Type": TEXT_MIME_TYPE, Vary: "User-Agent", ...protectedPageCacheHeader(env) },
    })
  }

  let path = url.pathname
  if (path.endsWith("/")) path += "index.html"
  else if (path.endsWith("/index")) path += ".html"
  else if (path.lastIndexOf("/") === 0 && path.indexOf(":") > 0) path = "/index.html"

  if (path === "/index.html") {
    const authResponse = await verifyAuth(request, env)
    if (authResponse !== null) return authResponse

    try {
      const { renderIndexPage } = await import("../pages/index.js")
      const page = await renderIndexPage(env, url.pathname)
      if (page) {
        return new Response(page, {
          headers: {
            "Content-Type": "text/html;charset=UTF-8",
            ...protectedPageCacheHeader(env),
            ...CROSS_ORIGIN_ISOLATION_HEADERS,
          },
        })
      }
    } catch (error) {
      console.error("SSR failed for index page, falling back to CSR:", error)
    }

    return new Response(
      renderReactDocument({
        manifest,
        entryKey: "index.html",
        title: env.INDEX_PAGE_TITLE,
        rootHtml: "",
        headHtml: `<script>window.__WRANGLER_CONFIG__=${JSON.stringify(publicEnv(env))}</script>`,
      }),
      {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          ...protectedPageCacheHeader(env),
          ...CROSS_ORIGIN_ISOLATION_HEADERS,
        },
      },
    )
  }

  if (path.startsWith("/assets/") || path === "/favicon.ico") {
    const assetsUrl = url
    assetsUrl.pathname = path
    const response = await env.ASSETS.fetch(assetsUrl)
    if (response.status === 404) throw new WorkerError(404, `asset '${path}' not found`)
    const pageMime = mime.getType(path) || "text/plain"
    const headers = new Headers(response.headers)
    if (!headers.has("Content-Type")) headers.set("Content-Type", `${pageMime};charset=UTF-8`)
    // A document using COEP may only create dedicated workers whose own main
    // script opts into a compatible embedder policy. Apply it to every JS
    // asset because Vite-hashed worker entries are indistinguishable from
    // ordinary chunks at routing time, and pthread workers recurse through
    // another generated JS entry.
    if (path.endsWith(".js")) {
      headers.set("Cross-Origin-Embedder-Policy", CROSS_ORIGIN_ISOLATION_HEADERS["Cross-Origin-Embedder-Policy"])
    }
    for (const [name, value] of Object.entries(staticPageCacheHeader(env))) headers.set(name, value)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  if (url.pathname === "/doc" || url.pathname.startsWith("/doc/")) {
    const isExplicitMd = url.pathname.endsWith(".md")
    const lookupPath = isExplicitMd ? url.pathname.slice(0, -3) : url.pathname
    const docMd = getDocMarkdown(lookupPath, env)
    if (docMd === null) throw new WorkerError(404, `doc page '${url.pathname}' not found`)
    const wantsMarkdown = isExplicitMd || isCurl
    return new Response(wantsMarkdown ? docMd : renderDocAsHtml(docMd), {
      headers: {
        "Content-Type": wantsMarkdown ? TEXT_MIME_TYPE : "text/html;charset=UTF-8",
        Vary: "User-Agent",
        ...staticPageCacheHeader(env),
      },
    })
  }

  return null
}
