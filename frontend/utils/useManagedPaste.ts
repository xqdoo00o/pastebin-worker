import { useEffect, useRef, type Dispatch, type SetStateAction, type TransitionStartFunction } from "react"

import { MAX_AUTO_FETCH_BYTES, PASSWD_SEP, type EncryptionScheme } from "../../shared/constants.js"
import type { PasteResponse, PublicEnv } from "../../shared/interfaces.js"
import { parsePath } from "../../shared/parsers.js"
import type { PasteEditState } from "../models/paste.js"
import { createUpdateSnapshot, uploadUpdateFields, type UpdateSnapshot } from "./content.js"
import { decodeKey, decrypt } from "./encryption.js"
import { isMetaResponse, parsePasteResponseHeaders, stripEncryptedSuffix } from "./pasteResponse.js"
import { isAbortError } from "./errors.js"
import type { PasteSetting } from "./pasteSetting.js"

interface ManagedPasteLoaderOptions {
  config: PublicEnv
  initialSetting: PasteSetting
  setPasteSetting: Dispatch<SetStateAction<PasteSetting>>
  setPasteResponse: Dispatch<SetStateAction<PasteResponse | undefined>>
  setEditorState: Dispatch<SetStateAction<PasteEditState>>
  setLastPasteUpdate: Dispatch<SetStateAction<UpdateSnapshot | null>>
  startTransition: TransitionStartFunction
  showError: (title: string, message: string) => void
  handleError: (title: string, error: unknown) => void
  handleFailedResponse: (title: string, response: Response) => Promise<void>
}

/** Load the current paste into the editor when the page opens on a management URL. */
export function useManagedPasteLoader({
  config,
  initialSetting,
  setPasteSetting,
  setPasteResponse,
  setEditorState,
  setLastPasteUpdate,
  startTransition,
  showError,
  handleError,
  handleFailedResponse,
}: ManagedPasteLoaderOptions): void {
  const initialOptions = useRef({
    config,
    initialSetting,
    setPasteSetting,
    setPasteResponse,
    setEditorState,
    setLastPasteUpdate,
    startTransition,
    showError,
    handleError,
    handleFailedResponse,
  })

  useEffect(() => {
    const {
      config,
      initialSetting,
      setPasteSetting,
      setPasteResponse,
      setEditorState,
      setLastPasteUpdate,
      startTransition,
      showError,
      handleError,
      handleFailedResponse,
    } = initialOptions.current
    if (typeof window === "undefined") return

    const pathname = location.pathname
    if (!pathname.includes(PASSWD_SEP)) return
    const { name, password, filename, ext } = parsePath(pathname)
    if (password === undefined || initialSetting.manageUrl !== "") return

    const controller = new AbortController()
    const { signal } = controller
    const manageUrl = `${config.DEPLOY_URL}/${name}:${password}`
    setPasteSetting((previous) => ({
      ...previous,
      transferMethod: "upload",
      uploadKind: "manage",
      manageUrl,
      expiration: config.DEFAULT_EXPIRATION,
      verifyP2P: false,
    }))

    let pasteUrl = `${config.DEPLOY_URL}/${name}`
    if (filename) pasteUrl = `${pasteUrl}/${filename}`
    if (ext) pasteUrl = `${pasteUrl}${ext}`
    const metadataUrl = `${config.DEPLOY_URL}/m/${name}`

    startTransition(async () => {
      try {
        const metaResponse = await fetch(metadataUrl, { cache: "no-cache", signal })
        if (!metaResponse.ok) {
          await handleFailedResponse(`Error on Fetching ${metadataUrl}`, metaResponse)
          return
        }
        const metadata: unknown = await metaResponse.json()
        signal.throwIfAborted()
        if (!isMetaResponse(metadata)) {
          showError("Error on Fetching Paste Metadata", "The metadata response is invalid.")
          return
        }
        const lastModifiedAt = new Date(metadata.lastModifiedAt).getTime()
        const expireAt = new Date(metadata.expireAt).getTime()
        const expirationSeconds =
          Number.isFinite(lastModifiedAt) && Number.isFinite(expireAt)
            ? Math.max(0, Math.round((expireAt - lastModifiedAt) / 1000))
            : 0
        setPasteResponse({ ...metadata, url: pasteUrl, manageUrl, expirationSeconds })

        const encryptionScheme = metadata.encryptionScheme as EncryptionScheme | undefined
        const isEncrypted = encryptionScheme !== undefined
        setPasteSetting((previous) => ({
          ...previous,
          doEncrypt: isEncrypted,
          readLimit: metadata.remainingReads === undefined ? "0" : String(metadata.remainingReads),
        }))

        const headResponse = await fetch(pasteUrl, { method: "HEAD", cache: "no-cache", signal })
        if (!headResponse.ok) {
          await handleFailedResponse(`Error on Fetching ${pasteUrl}`, headResponse)
          return
        }
        signal.throwIfAborted()
        const responseInfo = parsePasteResponseHeaders(headResponse.headers, encryptionScheme ?? null)
        const contentLanguage = responseInfo.highlightLanguage || metadata.highlightLanguage
        const isText = responseInfo.effectiveContentType?.startsWith("text/") || !!contentLanguage
        if (!isText || responseInfo.contentLength === null || responseInfo.contentLength >= MAX_AUTO_FETCH_BYTES) return

        const keyString = location.hash.slice(1)
        if (isEncrypted && keyString.length === 0) {
          showError(
            "Decryption key required",
            "This paste is encrypted. Open the manage URL with the decryption key after # to edit the plaintext.",
          )
          return
        }

        const response = await fetch(pasteUrl, { cache: "no-cache", signal })
        if (!response.ok) {
          await handleFailedResponse(`Error on Fetching ${pasteUrl}`, response)
          return
        }

        let pasteFilename = filename || responseInfo.filename
        if (isEncrypted) pasteFilename = stripEncryptedSuffix(pasteFilename)
        pasteFilename ||= metadata.filename

        let editContent: string
        if (isEncrypted) {
          let key: CryptoKey
          try {
            key = await decodeKey(encryptionScheme, keyString)
          } catch (error) {
            showError("Invalid decryption key", (error as Error).message)
            return
          }
          const encryptedBytes = new Uint8Array(await response.arrayBuffer())
          signal.throwIfAborted()
          const decrypted = await decrypt(encryptionScheme, key, encryptedBytes)
          signal.throwIfAborted()
          if (!decrypted) {
            showError(
              "Decryption failed",
              "Could not decrypt the paste with the provided key. The URL fragment may be wrong, " +
                "or the paste has been replaced or corrupted.",
            )
            return
          }
          editContent = new TextDecoder().decode(decrypted)
        } else {
          editContent = await response.text()
          signal.throwIfAborted()
        }

        const nextEditorState: PasteEditState = {
          editKind: "edit",
          editContent,
          files: [],
          editHighlightLang: contentLanguage || undefined,
          editFilename: pasteFilename,
        }
        const nextSetting: PasteSetting = {
          ...initialSetting,
          transferMethod: "upload",
          uploadKind: "manage",
          manageUrl,
          expiration: config.DEFAULT_EXPIRATION,
          readLimit: metadata.remainingReads === undefined ? "0" : String(metadata.remainingReads),
          doEncrypt: isEncrypted,
          verifyP2P: false,
        }
        setEditorState(nextEditorState)
        setLastPasteUpdate(createUpdateSnapshot(nextEditorState, uploadUpdateFields(nextSetting)))
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return
        handleError(`Error on Fetching ${pasteUrl}`, error)
      }
    })

    return () => controller.abort()
    // This initializer intentionally captures the first render. Later setting
    // changes must not restart a management URL download.
  }, [])
}
