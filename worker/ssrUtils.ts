import { prerender } from "react-dom/static.edge"
import type { ReactNode } from "react"
import { pickPublicEnv, type PublicEnv } from "../shared/interfaces.js"
import { DARK_MODE_SCRIPT } from "../shared/darkMode.js"
import { escapeHtml } from "../shared/encoding.js"

// Slim per-entry asset map produced by the `ssr-manifest` Vite plugin in
// frontend/vite.config.js. Importing the full Vite manifest pulls every chunk
// (one per highlight.js language) into the worker bundle, which we don't want.
export interface SsrAssetPaths {
  jsFile: string
  jsPreloadPaths: string[]
  // ALL transitively-reached CSS chunk paths for this entry, not just one —
  // an entry like index.html now reaches both a Tailwind/component-styles
  // chunk and a highlight-theme chunk through different transitive imports.
  cssPaths: string[]
}

export type SsrManifest = Record<string, SsrAssetPaths>

/** Render a static React tree with the renderer that omits React DOM's legacy
 * string-rendering implementation. Callers already buffer the result before
 * composing the surrounding document, so streaming SSR provides no benefit. */
export async function renderStaticReact(node: ReactNode): Promise<string> {
  const { prelude } = await prerender(node)
  return await new Response(prelude).text()
}

export function getAssetPaths(manifest: SsrManifest, entryKey: string): SsrAssetPaths {
  return (
    manifest[entryKey] ?? {
      jsFile: `assets/${entryKey.replace(".html", ".js")}`,
      jsPreloadPaths: [],
      cssPaths: ["assets/style.css"],
    }
  )
}

export function renderModulePreloadLinks(jsPaths: readonly string[]): string {
  return jsPaths.map((p) => `<link rel="modulepreload" crossorigin href="/${p}">`).join("")
}

export function renderCssLinks(cssPaths: readonly string[]): string {
  return cssPaths.map((p) => `<link rel="stylesheet" href="/${p}">`).join("")
}

interface ReactDocumentOptions {
  manifest: SsrManifest
  entryKey: string
  title: string
  rootHtml: string
  headHtml?: string
  afterRootHtml?: string
}

export function renderReactDocument({
  manifest,
  entryKey,
  title,
  rootHtml,
  headHtml = "",
  afterRootHtml = "",
}: ReactDocumentOptions): string {
  const { jsFile, jsPreloadPaths, cssPaths } = getAssetPaths(manifest, entryKey)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<link rel="icon" href="/favicon.ico" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
${renderCssLinks(cssPaths)}
${renderModulePreloadLinks(jsPreloadPaths)}
<script>
${DARK_MODE_SCRIPT}
</script>
${headHtml}
</head>
<body>
<div id="root">${rootHtml}</div>
${afterRootHtml}
<script type="module" src="/${jsFile}"></script>
</body>
</html>`
}

export function publicEnv(env: Env): PublicEnv {
  return pickPublicEnv(env)
}

export const MAX_SSR_FILE_SIZE = 1024 * 1024 // 1MB
