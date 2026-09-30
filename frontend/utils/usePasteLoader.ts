import { useCallback, useEffect, useRef, useState } from "react"
import { BINARY_MIME_TYPE, MAX_AUTO_FETCH_BYTES } from "../../shared/constants.js"
import { base64ToBytes, decodeUtf8 } from "../../shared/encoding.js"
import type { MetaResponse, OriginalFileInfo } from "../../shared/interfaces.js"
import type { EncryptionScheme } from "../../shared/constants.js"
import { decryptResponseToFile, downloadResponseToFile, type DownloadedResponseFile } from "./responseDownload.js"
import { isMetaResponse, parsePasteResponseHeaders, stripEncryptedSuffix } from "./pasteResponse.js"
import { triggerUrlDownload } from "./download.js"
import { mediaKindOfType } from "./filePreview.js"
import { isAbortError } from "./errors.js"

export interface PasteLoaderInitialState {
  pasteFile?: File
  pasteContentBuffer?: Uint8Array
  pasteText?: string
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
  text?: string
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
    pasteText: initialData.isBinary || scheme ? undefined : (decodeUtf8(responseBytes) ?? undefined),
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
  const [state, setState] = useState<PasteLoaderState>({
    ...initialState,
    isLoading: false,
    isDownloading: false,
    pendingInfo: null,
    mediaInfo: null,
  })
  const patchState = useCallback((patch: Partial<PasteLoaderState>) => {
    setState((previous) => ({ ...previous, ...patch }))
  }, [])

  const abortControllerRef = useRef<AbortController | null>(null)
  const fetchingBodyRef = useRef<symbol | null>(null)
  const downloadingRef = useRef<symbol | null>(null)
  const temporaryFileCleanupRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const retainedDownloadUrlsRef = useRef(new Map<string, (() => void) | undefined>())
  const initialLoadStartedRef = useRef(false)
  const callbacksRef = useRef({ onReadConsumed, showError, handleFailedResponse })
  callbacksRef.current = { onReadConsumed, showError, handleFailedResponse }

  const fetchMetadata = useCallback(
    async (signal = abortControllerRef.current!.signal): Promise<MetaResponse | null> => {
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
    [name],
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
    async (includeContent = false, signal = abortControllerRef.current!.signal): Promise<FetchedPasteFile | null> => {
      try {
        const response = await fetch(pasteUrl, { cache: "no-cache", signal })
        signal.throwIfAborted()
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

        const didDecrypt = scheme !== null && keyString.length > 0
        const downloadOptions = {
          filename: inferredFilename || name,
          type: responseInfo.mimeType,
          includeContent,
          signal,
        }
        let downloaded: DownloadedResponseFile
        if (didDecrypt) {
          try {
            downloaded = await decryptResponseToFile(response, scheme, keyString, downloadOptions)
          } catch (error) {
            if (signal.aborted || isAbortError(error)) return null
            callbacksRef.current.showError(
              "Decryption failed",
              `${(error as Error).message}. The URL fragment may be wrong, or the paste has been replaced or corrupted.`,
            )
            return null
          }
        } else {
          downloaded = await downloadResponseToFile(response, {
            ...downloadOptions,
            expectedSize: state.pendingInfo?.sizeBytes ?? state.mediaInfo?.sizeBytes ?? undefined,
            opfsThreshold: includeContent && remainingReads === null ? Number.POSITIVE_INFINITY : undefined,
          })
        }
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
          didDecrypt,
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return null
        callbacksRef.current.showError(`Error on fetching ${pasteUrl}`, (error as Error).toString())
        console.error(error)
        return null
      }
    },
    [ext, fetchMetadata, filename, name, pasteUrl, state.metaFilename, state.pendingInfo, state.mediaInfo, url],
  )

  const loadBody = useCallback(
    async (signal = abortControllerRef.current!.signal) => {
      if (signal.aborted || fetchingBodyRef.current) return
      const operation = Symbol()
      fetchingBodyRef.current = operation
      patchState({ isLoading: true, pendingInfo: null, mediaInfo: null })
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
          pasteText: undefined,
          pasteLang: paste.lang,
          ...(paste.filenameFromDisp ? { metaFilename: paste.filenameFromDisp } : {}),
          ...(paste.scheme ? { isDecrypted: paste.didDecrypt ? "decrypted" : "encrypted" } : {}),
        }
        if (paste.scheme && !paste.didDecrypt) {
          patch.isFileBinary = true
          patch.guessedEncoding = null
        } else {
          const text = decodeUtf8(paste.content)
          patch.pasteText = text ?? undefined
          patch.isFileBinary = text === null
          patch.guessedEncoding = text === null ? null : "UTF-8"
        }
        patchState(patch)
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) {
          callbacksRef.current.showError(`Error on fetching ${pasteUrl}`, (error as Error).toString())
        }
      } finally {
        if (fetchingBodyRef.current === operation) fetchingBodyRef.current = null
        if (!signal.aborted) patchState({ isLoading: false })
      }
    },
    [fetchPasteFile, pasteUrl, patchState],
  )

  const downloadBody = useCallback(
    async (signal = abortControllerRef.current!.signal) => {
      if (signal.aborted || downloadingRef.current) return
      const operation = Symbol()
      downloadingRef.current = operation
      patchState({ isDownloading: true })
      try {
        const paste = await fetchPasteFile(false, signal)
        if (paste && !signal.aborted) downloadFile(paste.file, paste.cleanup, paste.deferCleanup)
        else await paste?.cleanup?.()
      } finally {
        if (downloadingRef.current === operation) downloadingRef.current = null
        if (!signal.aborted) patchState({ isDownloading: false })
      }
    },
    [downloadFile, fetchPasteFile, patchState],
  )

  const showPreview = useCallback(
    (preview: PastePreview) => {
      patchState({
        pasteFile: preview.file,
        pasteContentBuffer: preview.content,
        pasteText: preview.text,
        pasteLang: preview.lang,
        isFileBinary: preview.isBinary,
        guessedEncoding: preview.encoding,
      })
    },
    [patchState],
  )

  const showMediaPreview = useCallback(
    (file: File) => {
      patchState({
        pasteFile: file,
        pasteContentBuffer: undefined,
        pasteText: undefined,
        pasteLang: undefined,
        isFileBinary: false,
        guessedEncoding: null,
      })
    },
    [patchState],
  )

  const clearPreview = useCallback(() => {
    patchState({ pasteFile: undefined, pasteContentBuffer: undefined, pasteText: undefined, isLoading: false })
  }, [patchState])

  const setLoading = useCallback((isLoading: boolean) => patchState({ isLoading }), [patchState])

  const dispose = useCallback(() => {
    abortControllerRef.current?.abort()
    fetchingBodyRef.current = null
    downloadingRef.current = null
    void temporaryFileCleanupRef.current?.()
    temporaryFileCleanupRef.current = undefined
    for (const [downloadUrl, deferCleanup] of retainedDownloadUrlsRef.current) {
      URL.revokeObjectURL?.(downloadUrl)
      deferCleanup?.()
    }
    retainedDownloadUrlsRef.current.clear()
  }, [])

  useEffect(() => {
    abortControllerRef.current = new AbortController()
    initialLoadStartedRef.current = false
    return dispose
  }, [dispose])

  useEffect(() => {
    if (initialLoadStartedRef.current) return
    if (!enabled) return
    initialLoadStartedRef.current = true
    if (window.__PASTE_DATA__) {
      callbacksRef.current.onReadConsumed(window.__PASTE_DATA__.metadata.remainingReads)
      return
    }
    const signal = abortControllerRef.current!.signal
    void (async () => {
      patchState({ isLoading: true })
      try {
        const headResponse = await fetch(pasteUrl, { method: "HEAD", cache: "no-cache", signal })
        signal.throwIfAborted()
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
        patchState({
          isDecrypted: isEncrypted ? "encrypted" : "not encrypted",
          ...(filenameFromHead ? { metaFilename: filenameFromHead } : {}),
        })

        const shouldAwaitMetadata = contentLength === null
        const metadataPromise = fetchMetadata(signal)
        const metadata = shouldAwaitMetadata ? await metadataPromise : null
        signal.throwIfAborted()
        const applyMetadata = (value: MetaResponse | null) => {
          if (!value) return
          patchState({
            ...(!filenameFromHead && value.filename ? { metaFilename: value.filename } : {}),
            ...(value.filenames ? { originalFiles: value.filenames } : {}),
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
        const isMedia = mediaKindOfType(effectiveContentType ?? "") !== null
        const sizeOk = sizeBytes !== null && sizeBytes < MAX_AUTO_FETCH_BYTES

        if (isReadLimited) {
          patchState({ pendingInfo: { sizeBytes, rawUrl: pasteUrl, contentType: effectiveContentType, isReadLimited } })
        } else if ((isText || (isMedia && isEncrypted)) && sizeOk) {
          await loadBody(signal)
        } else if (isMedia && !isEncrypted) {
          patchState({ mediaInfo: { sizeBytes, rawUrl: pasteUrl, contentType: effectiveContentType! } })
        } else {
          patchState({ pendingInfo: { sizeBytes, rawUrl: pasteUrl, contentType: effectiveContentType } })
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return
        callbacksRef.current.showError(`Error on Fetching ${pasteUrl}`, (error as Error).toString())
        console.error(error)
      } finally {
        if (!signal.aborted) patchState({ isLoading: false })
      }
    })()
  }, [enabled, ext, fetchMetadata, filename, loadBody, name, pasteUrl, patchState, url.searchParams])

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
