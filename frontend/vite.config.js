import { defineConfig } from "vite"
import { resolve } from "path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { readFileSync, writeFileSync } from "node:fs"
import * as toml from "toml"
import { DARK_MODE_SCRIPT } from "../shared/darkMode.ts"
import { hljsAliasesPlugin } from "./vite.hljs-aliases.config.js"

export default defineConfig(({ mode }) => {
  const wranglerConfigText = readFileSync("wrangler.toml", "utf8")
  const wranglerConfigParsed = toml.parse(wranglerConfigText)

  const vars =
    mode === "development"
      ? { ...wranglerConfigParsed.vars, DEPLOY_URL: "http://localhost:8787", INDEX_PAGE_TITLE: "Pastebin Worker (dev)" }
      : wranglerConfigParsed.vars

  const transformHtmlPlugin = () => ({
    name: "transform-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replace(/%INDEX_PAGE_TITLE%/g, vars.INDEX_PAGE_TITLE)
          .replace(/%DARK_MODE_SCRIPT%/g, DARK_MODE_SCRIPT)
      },
    },
  })

  // The full Vite manifest lists every emitted chunk (~80KB once per-language
  // highlight.js splitting kicks in). The worker only needs each HTML/JS
  // entry's resolved jsFile + JS preload/CSS paths reachable through its
  // import graph — emit a slim version next to the full manifest and have
  // the worker import that.
  const ssrManifestPlugin = () => ({
    name: "ssr-manifest",
    apply: "build",
    closeBundle() {
      const manifestPath = resolve(import.meta.dirname, "../dist/frontend/.vite/manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      const resolveEntry = (entryKey) => {
        const entry = manifest[entryKey]
        const jsFile = entry?.file || `assets/${entryKey.replace(".html", ".js")}`
        // Walk the import graph to collect every CSS chunk reachable from
        // this entry. An entry may transitively reach several CSS chunks
        // (e.g. a Tailwind chunk + a highlight-theme chunk via different
        // imported components), and the page needs all of them.
        //
        // `visited` tracks manifest keys (strings), not entry objects: that
        // way the cycle guard doesn't rely on the JSON parse cache returning
        // the same object reference on repeated lookups.
        const css = new Set()
        const jsPreload = new Set()
        const visited = new Set()
        const walk = (key, isRoot = false) => {
          if (!key || visited.has(key)) return
          visited.add(key)
          const e = manifest[key]
          if (!e) return
          for (const p of e.css || []) css.add(p)
          for (const k of e.imports || []) walk(k)
          if (!isRoot && e.file?.endsWith(".js")) jsPreload.add(e.file)
        }
        walk(entryKey, true)
        const cssPaths = css.size > 0 ? [...css] : ["assets/style.css"]
        return { jsFile, jsPreloadPaths: [...jsPreload], cssPaths }
      }
      const slim = {
        "index.html": resolveEntry("index.html"),
        "display.html": resolveEntry("display.html"),
        // Vanilla bootstrap for the /a/<paste> markdown render page.
        "pages/render/markdown.ts": resolveEntry("pages/render/markdown.ts"),
      }
      writeFileSync(
        resolve(import.meta.dirname, "../dist/frontend/.vite/ssr-manifest.json"),
        JSON.stringify(slim, null, 2),
      )
    },
  })

  return {
    plugins: [react(), tailwindcss(), transformHtmlPlugin(), ssrManifestPlugin(), hljsAliasesPlugin()],
    define: {
      __WRANGLER_CONFIG__: JSON.stringify(vars),
      // The hosted frontend ships SIMD/scalar codec builds and chooses at runtime.
      __WASM_VARIANT__: JSON.stringify("auto"),
    },
    server: {
      port: 5173,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    build: {
      manifest: true,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "index.html"),
          display: resolve(import.meta.dirname, "display.html"),
          opticalReceive: resolve(import.meta.dirname, "optical-receive.html"),
          opticalSend: resolve(import.meta.dirname, "optical-send.html"),
          markdown: resolve(import.meta.dirname, "pages/render/markdown.ts"),
        },
        output: {
          // Keep real lazy-entry names useful in DevTools, but do not expose
          // Rolldown's entry-set bookkeeping as enormous shared filenames.
          chunkFileNames: (chunk) => (chunk.isDynamicEntry ? "assets/[name]-[hash].js" : "assets/chunk-[hash].js"),
          assetFileNames: (asset) =>
            asset.names.some((name) => name.endsWith(".css"))
              ? "assets/style-[hash][extname]"
              : "assets/[name]-[hash][extname]",
          // Multiple HTML/JS entries share most of the React UI. Rolldown's
          // default splitting preserves every small shared boundary, which
          // turns the initial page load into dozens of sub-5 kB requests.
          // Coalesce those fragments while keeping real dynamic entries
          // (highlight languages, workers, QR/P2P features) lazy-loaded.
          codeSplitting: {
            groups: [
              {
                // Group modules by the user-defined entries that reach them
                // through static imports. Dynamic-entry consumers deliberately
                // do not affect the signature: otherwise a shared helper gets
                // split once for every lazy feature that happens to use it.
                name: (id, context) => {
                  const entries = new Set()
                  const visited = new Set()
                  const walkImporters = (moduleId) => {
                    if (visited.has(moduleId)) return
                    visited.add(moduleId)
                    const info = context.getModuleInfo(moduleId)
                    if (!info) return
                    if (info.isEntry) {
                      entries.add(moduleId.replaceAll("\\", "/"))
                      return
                    }
                    for (const importer of info.importers) walkImporters(importer)
                  }
                  walkImporters(id)
                  return entries.size > 0 ? `initial:${[...entries].sort().join("|")}` : null
                },
                tags: ["$initial"],
                test: (id) => {
                  const normalized = id.replaceAll("\\", "/")
                  return (
                    !normalized.endsWith(".html") &&
                    !normalized.endsWith("/pages/render/index.tsx") &&
                    !normalized.endsWith("/pages/render/display.tsx") &&
                    !normalized.endsWith("/pages/render/markdown.ts") &&
                    !normalized.endsWith("/optical/receive/bootstrap.tsx") &&
                    !normalized.endsWith("/optical/send/main.tsx")
                  )
                },
                includeDependenciesRecursively: false,
              },
            ],
          },
        },
      },
    },
  }
})
