import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"

// Reuse the resolved homepage entry from the SSR manifest build step.
export function writePwaFiles(outputDir, title, entry) {
  const webManifest = JSON.stringify(
    {
      id: "/",
      name: title,
      short_name: title,
      description: "Share text and files with Upload, direct P2P, or QR transfer.",
      lang: "en",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [192, 512].map((size) => ({
        src: `/pwa/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "any maskable",
      })),
    },
    null,
    2,
  )
  writeFileSync(resolve(outputDir, "manifest.webmanifest"), webManifest)

  // Large WASM codecs and optional UI chunks are cached only when used.
  const precache = [
    `/${entry.jsFile}`,
    ...entry.jsPreloadPaths.map((path) => `/${path}`),
    ...entry.cssPaths.map((path) => `/${path}`),
    "/manifest.webmanifest",
    "/pwa/icon-192.png",
    "/pwa/icon-512.png",
    "/pwa/apple-touch-icon.png",
    "/favicon.ico",
  ]
  const assets = new Set(precache)
  // Worker chunks and their WASM dependencies are emitted separately and
  // do not all appear in Vite's HTML entry manifest.
  for (const file of readdirSync(resolve(outputDir, "assets"), { recursive: true, withFileTypes: true })) {
    if (file.isFile()) assets.add(`/${relative(outputDir, resolve(file.parentPath, file.name)).replaceAll("\\", "/")}`)
  }
  const assetPaths = [...assets].sort()
  const worker = readFileSync(resolve(import.meta.dirname, "pwa/service-worker.js"), "utf8")
    .replace("__PWA_ENTRY__", `/${entry.jsFile}`)
    .replace("/* PWA_ASSETS */ []", JSON.stringify(assetPaths))
    .replace("/* PWA_PRECACHE */ []", JSON.stringify(precache))
  const version = createHash("sha256").update(worker)
  // Include unhashed icons and every emitted resource in the revision.
  for (const path of assetPaths) version.update(path).update(readFileSync(resolve(outputDir, `.${path}`)))
  writeFileSync(resolve(outputDir, "sw.js"), worker.replace("__PWA_VERSION__", version.digest("hex").slice(0, 16)))
}
