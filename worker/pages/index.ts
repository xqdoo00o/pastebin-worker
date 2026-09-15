import React from "react"
import { PasteBinInitialView } from "../../frontend/pages/PasteBinInitialView.js"
import manifest from "../../dist/frontend/.vite/ssr-manifest.json"
import { PASSWD_SEP } from "../../shared/constants.js"
import { publicEnv, renderReactDocument, renderStaticReact } from "../ssrUtils.js"

export async function renderIndexPage(env: Env, pathname: string): Promise<string | null> {
  // Admin URLs (containing password separator) skip SSR because they need client-side fetch
  if (pathname.includes(PASSWD_SEP)) {
    return null
  }

  // Build React element
  const config = publicEnv(env)

  const reactElement = React.createElement(React.StrictMode, null, React.createElement(PasteBinInitialView, { config }))

  const html = await renderStaticReact(reactElement)

  return renderReactDocument({
    manifest,
    entryKey: "index.html",
    title: env.INDEX_PAGE_TITLE,
    rootHtml: html,
  })
}
