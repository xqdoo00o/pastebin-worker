// Build-time replacements bind each cache to the exact emitted frontend.
const CACHE_NAME = "pastebin-pwa-__PWA_VERSION__"
const HOME_SCRIPT_PATH = "__PWA_ENTRY__"
const STATIC_PATHS = new Set(/* PWA_ASSETS */ [])
const PRECACHE_PATHS = /* PWA_PRECACHE */ []
const HOME_PATHS = new Set(["/", "/index", "/index.html"])

function canCache(response) {
  return (
    response.status === 200 &&
    !response.redirected &&
    !/(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get("Cache-Control") || "")
  )
}

async function saveHome(cache, response) {
  if (canCache(response) && response.headers.get("Content-Type")?.includes("text/html")) {
    // A waiting update can serve newer HTML while this worker still controls
    // an open transfer. Keep its offline shell paired with its own JS build.
    if ((await response.clone().text()).includes(`src="${HOME_SCRIPT_PATH}"`)) await cache.put("/", response)
  } else {
    // In particular, discard a formerly public shell when auth is enabled.
    await cache.delete("/")
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      await cache.addAll(PRECACHE_PATHS.map((path) => new Request(path, { cache: "reload" })))
      // Auth-protected homepages stay out of Cache Storage. Failure to obtain
      // the homepage must not prevent static assets or installation working.
      try {
        await saveHome(cache, await fetch(new Request("/", { cache: "reload" })))
      } catch {
        // The homepage will be cached on a later successful navigation.
      }
    })(),
  )
  // Let updates wait for open pages to close so active transfers keep their
  // original workers, codec assets, and cache until they finish.
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("pastebin-pwa-") && name !== CACHE_NAME) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})

async function fetchWithCache(event, isHome) {
  const request = event.request
  // Storage failures should never prevent an otherwise working online page.
  const cache = await caches.open(CACHE_NAME).catch(() => undefined)
  if (!isHome) {
    const cached = await cache?.match(request).catch(() => undefined)
    if (cached) return cached
  }
  try {
    const response = await fetch(request, isHome ? { cache: "no-cache" } : undefined)
    if (cache && (isHome || canCache(response))) {
      event.waitUntil(
        (isHome ? saveHome(cache, response.clone()) : cache.put(request, response.clone())).catch(() => undefined),
      )
    }
    return response
  } catch (error) {
    const cached = isHome ? await cache?.match("/").catch(() => undefined) : undefined
    if (cached) return cached
    throw error
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search || request.headers.has("Range"))
    return

  // Only the plain homepage can fall back offline. Paste bodies, metadata,
  // management URLs, P2P signaling, and all mutations remain network-only.
  const isHome = request.mode === "navigate" && HOME_PATHS.has(url.pathname)
  if (isHome || STATIC_PATHS.has(url.pathname)) event.respondWith(fetchWithCache(event, isHome))
})
