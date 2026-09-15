import React from "react"
import { DisplayPasteView } from "../../frontend/pages/DisplayPasteView.js"
import type { PasteMetadata } from "../storage/storage.js"
import { hasReadLimit, metaResponseFromMetadata } from "../storage/storage.js"
import type { SerializedPasteData } from "../../shared/interfaces.js"
import manifest from "../../dist/frontend/.vite/ssr-manifest.json"
import { bytesToBase64, detectUtf8 } from "../../shared/encoding.js"
import { MAX_SSR_FILE_SIZE, publicEnv, renderReactDocument, renderStaticReact } from "../ssrUtils.js"
import { filenameForTitle, itemCountLabel } from "../../shared/format.js"

export function canRenderDisplayPage(metadata: PasteMetadata): boolean {
  return !hasReadLimit(metadata) && !metadata.encryptionScheme && metadata.sizeBytes <= MAX_SSR_FILE_SIZE
}

export async function renderDisplayPage(
  env: Env,
  name: string,
  urlFilename: string | undefined,
  urlExt: string | undefined,
  urlLang: string | undefined,
  paste: ArrayBuffer | ReadableStream<Uint8Array>,
  metadata: PasteMetadata,
  contentType: string,
): Promise<string | null> {
  if (!canRenderDisplayPage(metadata)) {
    return null
  }

  const content = paste instanceof ArrayBuffer ? paste : await new Response(paste).arrayBuffer()

  const encoding = detectUtf8(new Uint8Array(content))
  const isBinary = encoding === null

  const contentBase64 = bytesToBase64(new Uint8Array(content))

  const metaResponse = metaResponseFromMetadata(metadata)

  const serializedData: SerializedPasteData = {
    content: contentBase64,
    contentType,
    metadata: metaResponse,
    name,
    isBinary,
    guessedEncoding: encoding,
  }

  const inferredFilename = urlFilename || (urlExt && name + urlExt) || metadata.filename || name
  const pasteFile = new File([content], inferredFilename, { type: contentType })
  const displayName = metadata.filenames?.length
    ? itemCountLabel(metadata.filenames.length)
    : filenameForTitle(metadata.filename)
  const titleUrlFilename = filenameForTitle(urlFilename)
  const titleName =
    name + (titleUrlFilename ? " / " + titleUrlFilename : urlExt ? urlExt : displayName ? " / " + displayName : "")

  const config = publicEnv(env)

  const reactElement = React.createElement(
    React.StrictMode,
    null,
    React.createElement(DisplayPasteView, {
      forceShowBinary: false,
      name,
      ext: urlExt,
      filename: urlFilename,
      config,
      paste: {
        file: pasteFile,
        contentBuffer: new Uint8Array(content),
        lang: urlLang || metadata.highlightLanguage,
        isFileBinary: isBinary,
        guessedEncoding: encoding,
        isDecrypted: "not encrypted",
        isLoading: false,
        isDownloading: false,
        metaFilename: metadata.filename,
        originalFiles: metadata.filenames,
      },
      actions: {
        setForceShowBinary: () => {
          // SSR: no-op
        },
      },
    }),
  )

  const html = await renderStaticReact(reactElement)

  const pasteData = JSON.stringify(serializedData)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  return renderReactDocument({
    manifest,
    entryKey: "display.html",
    title: `${env.INDEX_PAGE_TITLE} / ${titleName}`,
    rootHtml: html,
    afterRootHtml: `<script id="__PASTE_DATA__" type="application/json">${pasteData}</script>
<script>window.__PASTE_DATA__=JSON.parse(document.getElementById('__PASTE_DATA__').textContent)</script>`,
  })
}
