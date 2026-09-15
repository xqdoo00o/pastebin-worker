import { dirname, resolve } from "node:path"
import { readFileSync, rmSync } from "node:fs"
import * as toml from "toml"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { DARK_MODE_SCRIPT } from "../shared/darkMode.ts"
import { hljsAliasesPlugin } from "./vite.hljs-aliases.config.js"

/**
 * Build one optical sender/receiver as a self-contained HTML file that can be
 * opened from file://. Page-specific configs supply only their entry point and
 * worker factory; all inlining and output-safety rules stay identical.
 */
export function createOpticalStandaloneConfig({
  mode,
  name,
  entryName,
  entryFile,
  outputDirectory,
  scalarMode,
  workerImporterPath,
  inlineWorkerFactoryPath,
}) {
  const frontendDir = import.meta.dirname
  const wasmVariant = mode === scalarMode ? "scalar" : "simd"
  const wranglerConfigParsed = toml.parse(readFileSync(resolve(frontendDir, "../wrangler.toml"), "utf8"))
  const vars = wranglerConfigParsed.vars
  const faviconDataUrl = `data:image/x-icon;base64,${readFileSync(resolve(frontendDir, "public/favicon.ico")).toString("base64")}`
  const inlineWorkerSource = readFileSync(resolve(frontendDir, inlineWorkerFactoryPath), "utf8")
  const inlineWorkerBindings = Array.from(inlineWorkerSource.matchAll(/\?worker&inline/g), (_, index) =>
    index === 0 ? "jsContent" : `jsContent$${index}`,
  )

  const inlineWorkersPlugin = () => ({
    name: `inline-${name}-workers`,
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "./worker-factory.js" || !importer?.replace(/\\/g, "/").includes(workerImporterPath)) return null
      return resolve(frontendDir, inlineWorkerFactoryPath)
    },
  })

  const singleFilePlugin = () => ({
    name: `${name}-single-file`,
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      // Rolldown output minification currently runs after Vite's dynamic-import
      // analysis and can leave its no-dependency preload marker behind after
      // code splitting has already been disabled. Vite normally lowers this
      // exact case to `void 0`; do the equivalent at the final output boundary.
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") output.code = output.code.replaceAll("__VITE_PRELOAD__", "void 0")
      }

      const htmlAsset = Object.values(bundle).find(
        (asset) => asset.type === "asset" && asset.fileName.endsWith(".html"),
      )
      if (!htmlAsset || htmlAsset.type !== "asset") return

      // Vite injects `?worker&inline` payloads as string bindings, then wraps
      // them in `new Blob([preamble, binding])`. Verify that a future bundler
      // upgrade has not renamed a page binding onto one of those payloads.
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        for (const match of output.code.matchAll(
          /new Blob\(\[[^,]+,([A-Za-z_$][\w$]*)\],\{type:[`'"]text\/javascript;charset=utf-8[`'"]\}\)/g,
        )) {
          const binding = match[1]
          const assignment = output.code.lastIndexOf(`${binding}=`, match.index)
          const valueStart = output.code[assignment + binding.length + 1]
          if (assignment < 0 || !["'", '"', "`"].includes(valueStart))
            this.error(`Inline worker payload binding "${binding}" was corrupted during minification.`)
        }
      }

      const assetFileName = (path) => path.replace(/^\//, "").replace(/^\.\//, "")
      let html = String(htmlAsset.source)
        .replace(/%INDEX_PAGE_TITLE%/g, vars.INDEX_PAGE_TITLE)
        .replace(/%DARK_MODE_SCRIPT%/g, DARK_MODE_SCRIPT)

      html = html.replace(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*>\s*<\/script>/g, (match, src) => {
        const chunk = bundle[assetFileName(src)]
        if (!chunk || chunk.type !== "chunk") return match
        delete bundle[assetFileName(src)]
        return `<script type="module">${chunk.code}</script>`
      })

      html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (match, href) => {
        const asset = bundle[assetFileName(href)]
        if (!asset || asset.type !== "asset") return match
        delete bundle[assetFileName(href)]
        return `<style>${String(asset.source)}</style>`
      })

      // Vite emits a relative URL for the source's absolute favicon when
      // base is "./", so support both spellings before enforcing one file.
      html = html.replace(/href="(?:\.\/|\/)favicon\.ico"/, `href="${faviconDataUrl}"`)

      if (html.includes("__VITE_PRELOAD__")) this.error("Standalone HTML contains an unresolved Vite preload marker.")
      if (/\bimport\s*\(/.test(html)) this.error("Standalone HTML contains a runtime dynamic import.")

      // Inline workers can leave detached chunks. A referenced output breaks
      // the contract; every unreferenced one is redundant and removed.
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output === htmlAsset) continue
        if (html.includes(fileName)) this.error(`Standalone HTML still references emitted output: ${fileName}`)
        delete bundle[fileName]
      }

      htmlAsset.source = html
      htmlAsset.fileName = `${name}${wasmVariant === "scalar" ? "-scalar" : ""}.html`
    },
    writeBundle(outputOptions) {
      if (!outputOptions.dir) return
      const outputDir = resolve(outputOptions.dir)
      const assetsDir = resolve(outputDir, "assets")
      if (dirname(assetsDir) !== outputDir)
        this.error(`Refusing to clean an unexpected standalone assets path: ${assetsDir}`)
      rmSync(assetsDir, { recursive: true, force: true })
    },
  })

  return {
    root: frontendDir,
    base: "./",
    plugins: [react(), tailwindcss(), hljsAliasesPlugin(), inlineWorkersPlugin(), singleFilePlugin()],
    define: {
      __WRANGLER_CONFIG__: JSON.stringify(vars),
      __WASM_VARIANT__: JSON.stringify(wasmVariant),
    },
    worker: {
      // Blob/data module workers are not consistently supported by file://.
      format: "iife",
    },
    build: {
      // Vite's default OXC identifier mangling runs after inline-worker source
      // is injected. It can reuse that injected variable's name for page code,
      // replacing the worker source with an unrelated value at runtime.
      // Keep OXC compression and regular name mangling, but protect every
      // Vite inline-worker payload binding used by this page from reuse.
      rolldownOptions: {
        input: {
          [entryName]: resolve(frontendDir, entryFile),
        },
        output: {
          // A standalone HTML cannot defer Emscripten factories to emitted JS
          // chunks. Folding dynamic imports also lets Vite resolve its preload
          // markers instead of leaving __VITE_PRELOAD__ in the inlined script.
          codeSplitting: false,
          minify: { compress: true, mangle: { reserved: inlineWorkerBindings }, codegen: true },
        },
      },
      outDir: resolve(frontendDir, outputDirectory),
      // SIMD and scalar exports intentionally coexist in one output directory.
      emptyOutDir: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      cssCodeSplit: false,
      copyPublicDir: false,
    },
  }
}
