import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { BINARY_MIME_TYPE, MAX_AUTO_FETCH_BYTES } from "../../shared/constants.js"
import { base64ToBytes, detectUtf8 } from "../../shared/encoding.js"
import type { MetaResponse, OriginalFileInfo } from "../../shared/interfaces.js"
import type { EncryptionScheme } from "../../shared/constants.js"
import { decryptResponseToFile, downloadResponseToFile } from "./responseDownload.js"
import { isMetaResponse, parsePasteResponseHeaders, stripEncryptedSuffix } from "./pasteResponse.js"
import { triggerUrlDownload } from "./download.js"
import { isAbortError } from "./errors.js"

export interface PasteLoaderInitialState {
  pasteFile?: File
  pasteContentBuffer?: Uint8Array
  pasteLang?: string
  isFileBinary: boolean
  guessedEncoding: string | null
  isDecrypted: "not encrypted" | "encrypted" | "decrypted"
  metaFilename?: string
  originalFiles?: OriginalFileInfo[]
}

export interface PastePendingInfo {
  sizeBytes: number | null
  rawUrl: string
  contentType: string | null
  isReadLimited?: boolean
}

export interface PasteMediaInfo {
  sizeBytes: number | null
  rawUrl: string
  contentType: string
}

interface FetchedPasteFile {
  file: File
  content?: Uint8Array
  cleanup?: () => Promise<void>
  deferCleanup?: () => void
  filenameFromDisp?: string
  lang?: string
  scheme: EncryptionScheme | null
  didDecrypt: boolean
}

interface PastePreview {
  file: File
  content: Uint8Array
  lang?: string
  isBinary: boolean
  encoding: string | null
}

interface PasteLoaderState extends PasteLoaderInitialState {
  isLoading: boolean
  isDownloading: boolean
  pendingInfo: PastePendingInfo | null
  mediaInfo: PasteMediaInfo | null
}

interface PasteLoaderAction {
  type: "patch"
  patch: Partial<PasteLoaderState>
}

function pasteLoaderReducer(state: PasteLoaderState, action: PasteLoaderAction): PasteLoaderState {
  return { ...state, ...action.patch }
}

interface PasteLoaderOptions {
  url: URL
  name: string
  ext?: string
  filename?: string
  enabled: boolean
  initialState: PasteLoaderInitialState
  onReadConsumed: (remainingReads: string | number | null | undefined) => void
  showError: (title: string, content: string) => void
  handleFailedResponse: (defaultTitle: string, response: Response) => Promise<void>
}

export function getInitialPasteState(
  url: URL,
  name: string,
  ext: string | undefined,
  filename: string | undefined,
): PasteLoaderInitialState {
  const initialData = window.__PASTE_DATA__
  if (!initialData) {
    return {
      isFileBinary: false,
      guessedEncoding: null,
      isDecrypted: "not encrypted",
    }
  }

  const responseBytes = base64ToBytes(initialData.content)
  const scheme = initialData.metadata.encryptionScheme as EncryptionScheme | undefined
  const lang = url.searchParams.get("lang") || initialData.metadata.highlightLanguage
  const inferredFilename = filename || (ext && name + ext) || initialData.metadata.filename

  return {
    pasteFile: new File([responseBytes], inferredFilename || name, {
      type: initialData.contentType || initialData.metadata.mimeType || "",
    }),
    pasteContentBuffer: responseBytes,
    pasteLang: lang || undefined,
    isFileBinary: initialData.isBinary,
    guessedEncoding: initialData.guessedEncoding,
    isDecrypted: scheme ? "encrypted" : "not encrypted",
    metaFilename: initialData.metadata.filename,
    originalFiles: initialData.metadata.filenames,
  }
}

export function usePasteLoader({
  url,
  name,
  ext,
  filename,
  enabled,
  initialState,
  onReadConsumed,
  showError,
  handleFailedResponse,
}: PasteLoaderOptions) {
  const pasteUrl = `/${name}`
  const [state, dispatch] = useReducer(pasteLoaderReducer, {
    ...initialState,
    isLoading: false,
    isDownloading: false,
    pendingInfo: null,
    mediaInfo: null,
  })

  const [abortController] = useState(() => new AbortController())
  const isFetchingBodyRef = useRef(false)
  const isDownloadingRef = useRef(false)
  const temporaryFileCleanupRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const retainedDownloadUrlsRef = useRef(new Map<string, (() => void) | undefined>())
  const initialLoadStartedRef = useRef(false)
  const callbacksRef = useRef({ onReadConsumed, showError, handleFailedResponse })
  callbacksRef.current = { onReadConsumed, showError, handleFailedResponse }

  const fetchMetadata = useCallback(
    async (signal = abortController.signal): Promise<MetaResponse | null> => {
      try {
        const response = await fetch(`/m/${name}`, { cache: "no-cache", signal })
        if (!response.ok) return null
        const metadata: unknown = await response.json()
        signal.throwIfAborted()
        return isMetaResponse(metadata) ? metadata : null
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return null
        console.warn(`Failed to fetch metadata for ${name}`, error)
        return null
      }
    },
    [abortController, name],
  )

  const downloadFile = useCallback((file: File, cleanup?: () => Promise<void>, deferCleanup?: () => void) => {
    const downloadBlob = file.type === BINARY_MIME_TYPE ? file : new Blob([file], { type: BINARY_MIME_TYPE })
    const downloadUrl = URL.createObjectURL(downloadBlob)
    triggerUrlDownload(downloadUrl, file.name)
    if (cleanup) {
      // There is no reliable browser event for when a Blob-backed download has
      // consumed its source. Keep OPFS-backed files alive for this page lifetime.
      retainedDownloadUrlsRef.current.set(downloadUrl, deferCleanup)
      return
    }
    window.setTimeout(() => URL.revokeObjectURL?.(downloadUrl), 1000)
  }, [])

  const fetchPasteFile = useCallback(
    async (includeContent = false, signal = abortController.signal): Promise<FetchedPasteFile | null> => {
      try {
        const response = await fetch(pasteUrl, { cache: "no-cache", signal })
        if (!response.ok) {
          await callbacksRef.current.handleFailedResponse("Failed to Fetch Paste", response)
          return null
        }
        const responseInfo = parsePasteResponseHeaders(response.headers)
        const { encryptionScheme: scheme, remainingReads, filename: filenameFromDisposition } = responseInfo
        const lang = url.searchParams.get("lang") || responseInfo.highlightLanguage
        let metadataFilename = state.metaFilename
        if (!filename && !ext && !filenameFromDisposition && !metadataFilename) {
          metadataFilename = stripEncryptedSuffix((await fetchMetadata(signal))?.filename)
        }
        signal.throwIfAborted()
        const inferredFilename = filename || (ext && name + ext) || filenameFromDisposition || metadataFilename
        const keyString = url.hash.slice(1)

        if (scheme === null || keyString.length === 0) {
          const downloaded = await downloadResponseToFile(response, {
            filename: inferredFilename || name,
            type: responseInfo.mimeType,
            includeContent,
            opfsThreshold: remainingReads === null ? Number.POSITIVE_INFINITY : undefined,
            signal,
          })
          if (signal.aborted) {
            await downloaded.cleanup?.()
            return null
          }
          callbacksRef.current.onReadConsumed(remainingReads)
          return {
            ...downloaded,
            filenameFromDisp: filenameFromDisposition,
            lang: lang || undefined,
            scheme,
            didDecrypt: false,
          }
        }

        try {
          const decrypted = await decryptResponseToFile(response, scheme, keyString, {
            filename: inferredFilename || name,
            type: responseInfo.mimeType,
            includeContent,
            signal,
          })
          if (signal.aborted) {
            await decrypted.cleanup?.()
            return null
          }
          callbacksRef.current.onReadConsumed(remainingReads)
          return {
            ...decrypted,
            filenameFromDisp: filenameFromDisposition,
            lang: lang || undefined,
            scheme,
            didDecrypt: true,
          }
        } catch (error) {
          if (signal.aborted || isAbortError(error)) return null
          callbacksRef.current.showError(
            "Decryption failed",
            `${(error as Error).message}. The URL fragment may be wrong, or the paste has been replaced or corrupted.`,
          )
          return null
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return null
        callbacksRef.current.showError(`Error on fetching ${pasteUrl}`, (error as Error).toString())
        console.error(error)
        return null
      }
    },
    [abortController, ext, fetchMetadata, filename, name, pasteUrl, state.metaFilename, url],
  )

  const loadBody = useCallback(
    async (signal = abortController.signal) => {
      if (isFetchingBodyRef.current) return
      isFetchingBodyRef.current = true
      dispatch({ type: "patch", patch: { isLoading: true, pendingInfo: null, mediaInfo: null } })
      try {
        const paste = await fetchPasteFile(true, signal)
        if (!paste) return
        if (signal.aborted) {
          await paste.cleanup?.()
          return
        }
        if (!paste.content) {
          await paste.cleanup?.()
          throw new Error("The downloaded file could not be loaded for preview")
        }

        await temporaryFileCleanupRef.current?.()
        if (signal.aborted) {
          await paste.cleanup?.()
          return
        }
        temporaryFileCleanupRef.current = paste.cleanup
        const patch: Partial<PasteLoaderState> = {
          pasteFile: paste.file,
          pasteContentBuffer: paste.content,
          pasteLang: paste.lang,
          ...(paste.filenameFromDisp ? { metaFilename: paste.filenameFromDisp } : {}),
          ...(paste.scheme ? { isDecrypted: paste.didDecrypt ? "decrypted" : "encrypted" } : {}),
        }
        if (paste.scheme && !paste.didDecrypt) {
          patch.isFileBinary = true
          patch.guessedEncoding = null
        } else {
          const encoding = detectUtf8(paste.content)
          patch.isFileBinary = encoding === null
          patch.guessedEncoding = encoding
        }
        dispatch({ type: "patch", patch })
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) {
          callbacksRef.current.showError(`Error on fetching ${pasteUrl}`, (error as Error).toString())
        }
      } finally {
        isFetchingBodyRef.current = false
        if (!signal.aborted) dispatch({ type: "patch", patch: { isLoading: false } })
      }
    },
    [abortController, fetchPasteFile, pasteUrl],
  )

  const downloadBody = useCallback(
    async (signal = abortController.signal) => {
      if (isDownloadingRef.current) return
      isDownloadingRef.current = true
      dispatch({ type: "patch", patch: { isDownloading: true } })
      try {
        const paste = await fetchPasteFile(false, signal)
        if (paste && !signal.aborted) downloadFile(paste.file, paste.cleanup, paste.deferCleanup)
        else await paste?.cleanup?.()
      } finally {
        isDownloadingRef.current = false
        if (!signal.aborted) dispatch({ type: "patch", patch: { isDownloading: false } })
      }
    },
    [abortController, downloadFile, fetchPasteFile],
  )

  const showPreview = useCallback((preview: PastePreview) => {
    dispatch({
      type: "patch",
      patch: {
        pasteFile: preview.file,
        pasteContentBuffer: preview.content,
        pasteLang: preview.lang,
        isFileBinary: preview.isBinary,
        guessedEncoding: preview.encoding,
      },
    })
  }, [])

  const showMediaPreview = useCallback((file: File) => {
    dispatch({
      type: "patch",
      patch: {
        pasteFile: file,
        pasteContentBuffer: undefined,
        pasteLang: undefined,
        isFileBinary: false,
        guessedEncoding: null,
      },
    })
  }, [])

  const clearPreview = useCallback(() => {
    dispatch({
      type: "patch",
      patch: { pasteFile: undefined, pasteContentBuffer: undefined, isLoading: false },
    })
  }, [])

  const setLoading = useCallback((isLoading: boolean) => {
    dispatch({ type: "patch", patch: { isLoading } })
  }, [])

  const dispose = useCallback(() => {
    abortController.abort()
    void temporaryFileCleanupRef.current?.()
    temporaryFileCleanupRef.current = undefined
    for (const [downloadUrl, deferCleanup] of retainedDownloadUrlsRef.current) {
      URL.revokeObjectURL?.(downloadUrl)
      deferCleanup?.()
    }
    retainedDownloadUrlsRef.current.clear()
  }, [abortController])

  useEffect(() => dispose, [dispose])

  useEffect(() => {
    if (initialLoadStartedRef.current) return
    initialLoadStartedRef.current = true
    if (window.__PASTE_DATA__) {
      callbacksRef.current.onReadConsumed(window.__PASTE_DATA__.metadata.remainingReads)
      return
    }
    if (!enabled) return

    const signal = abortController.signal
    void (async () => {
      dispatch({ type: "patch", patch: { isLoading: true } })
      try {
        const headResponse = await fetch(pasteUrl, { method: "HEAD", cache: "no-cache", signal })
        if (!headResponse.ok) {
          await callbacksRef.current.handleFailedResponse(`Error on Fetching ${pasteUrl}`, headResponse)
          return
        }
        signal.throwIfAborted()
        const responseInfo = parsePasteResponseHeaders(headResponse.headers)
        const {
          contentLength,
          highlightLanguage: declaredHighlightLanguage,
          encryptionScheme,
          effectiveContentType,
          filename: filenameFromHead,
          remainingReads,
        } = responseInfo
        const highlightLanguage = url.searchParams.get("lang") || declaredHighlightLanguage
        const isEncrypted = encryptionScheme !== null
        dispatch({
          type: "patch",
          patch: {
            isDecrypted: isEncrypted ? "encrypted" : "not encrypted",
            ...(filenameFromHead ? { metaFilename: filenameFromHead } : {}),
          },
        })

        const shouldAwaitMetadata = contentLength === null
        const metadataPromise = fetchMetadata(signal)
        const metadata = shouldAwaitMetadata ? await metadataPromise : null
        signal.throwIfAborted()
        const applyMetadata = (value: MetaResponse | null) => {
          if (!value) return
          dispatch({
            type: "patch",
            patch: {
              ...(!filenameFromHead && value.filename ? { metaFilename: value.filename } : {}),
              ...(value.filenames ? { originalFiles: value.filenames } : {}),
            },
          })
        }
        applyMetadata(metadata)
        if (!shouldAwaitMetadata) {
          void metadataPromise.then((value) => {
            if (!signal.aborted) applyMetadata(value)
          })
        }

        const sizeBytes = contentLength ?? metadata?.sizeBytes ?? null
        const isReadLimited = remainingReads !== null || metadata?.remainingReads !== undefined
        const isText = effectiveContentType?.startsWith("text/") || !!highlightLanguage
        const isMedia =
          effectiveContentType?.startsWith("image/") ||
          effectiveContentType?.startsWith("audio/") ||
          effectiveContentType?.startsWith("video/")
        const sizeOk = sizeBytes !== null && sizeBytes < MAX_AUTO_FETCH_BYTES

        if (isReadLimited) {
          dispatch({
            type: "patch",
            patch: { pendingInfo: { sizeBytes, rawUrl: pasteUrl, contentType: effectiveContentType, isReadLimited } },
          })
        } else if ((isText || (isMedia && isEncrypted)) && sizeOk) {
          await loadBody(signal)
        } else if (isMedia && !isEncrypted) {
          dispatch({
            type: "patch",
            patch: { mediaInfo: { sizeBytes, rawUrl: pasteUrl, contentType: effectiveContentType! } },
          })
        } else {
          dispatch({
            type: "patch",
            patch: { pendingInfo: { sizeBytes, rawUrl: pasteUrl, contentType: effectiveContentType } },
          })
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return
        callbacksRef.current.showError(`Error on Fetching ${pasteUrl}`, (error as Error).toString())
        console.error(error)
      } finally {
        if (!signal.aborted) dispatch({ type: "patch", patch: { isLoading: false } })
      }
    })()
  }, [abortController, enabled, ext, fetchMetadata, filename, loadBody, name, pasteUrl, url.searchParams])

  return {
    ...state,
    setLoading,
    showPreview,
    showMediaPreview,
    clearPreview,
    downloadFile,
    loadBody,
    downloadBody,
    dispose,
  }
}
