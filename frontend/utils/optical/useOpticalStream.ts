import { useCallback, useEffect, useRef, useState } from "react"
import { formatSize } from "../utils.js"
import { P2PWakeLock } from "../p2p/wakeLock.js"
import {
  fitsInOneStream,
  isOpticalCompressionCandidate,
  MAX_SOURCE_SYMBOLS,
  smallestSufficientFrameSize,
  sourceSymbolCount,
} from "../../optical/shared/protocol.js"
import { frameBytesOptionsForEcc, type OpticalTransferSettings } from "../../optical/shared/settings.js"
import type { PreparedOpticalFile, SenderWorkerOutput } from "../../optical/shared/worker-messages.js"
import { configuredWasmVariant, loadNanoRQCodecModule } from "../../optical/shared/wasm-module.js"
import { loadZstdEncoderWasmModule } from "../../wasm/zstd-loader.js"
import { loadXXHashWasmModule } from "../../wasm/xxhash-loader.js"
import { useApngExportController } from "./useApngExportController.js"
import { createOpticalSenderWorker } from "./worker-factory.js"
import { errorMessage } from "../errors.js"
import { readFileBytes } from "../byteSource.js"
import { inferHighlightLanguage, withHighlightLanguage } from "../../../shared/fileType.js"

export type { OpticalApngExportController } from "./useApngExportController.js"
import { OpticalPlaybackSession } from "../../optical/send/playback-session.js"

export interface OpticalStreamInfo {
  version: number
}

interface OpticalStreamOptions {
  file: File
  /** Explicit editor selection. When absent, code files are inferred by name. */
  highlightLanguage?: string
  settings: OpticalTransferSettings
  onError?: (error: Error) => void
}

export function useOpticalStream({ file, highlightLanguage, settings, onError }: OpticalStreamOptions) {
  const [preparedFile, setPreparedFile] = useState<PreparedOpticalFile>()
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState("Preparing QR camera stream...")
  const [streamInfo, setStreamInfo] = useState<OpticalStreamInfo>()
  const [streamReady, setStreamReady] = useState(false)
  const [rendererBackend, setRendererBackend] = useState<"webgl2" | "2d">("webgl2")
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [partCount, setPartCount] = useState(1)
  const [currentPart, setCurrentPart] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const resizeDisplayRef = useRef<(() => void) | null>(null)
  const fullscreenRef = useRef(false)
  const senderWorkerRef = useRef<Worker | null>(null)
  const streamMessageRef = useRef<((message: SenderWorkerOutput) => void) | null>(null)
  const streamSessionRef = useRef(0)
  /** Part the UI currently displays; survives effect re-runs for playback-only settings. */
  const activePartRef = useRef(0)
  const reportedErrorRef = useRef<string | undefined>(undefined)
  /** frameBytes+ecc key; a change rebuilds the codec and falls back to part 0. */
  const lastCodecRef = useRef<string | undefined>(undefined)
  const switchPartRef = useRef<(part: number) => void>(() => undefined)
  const mediaType = withHighlightLanguage(file.type, highlightLanguage ?? inferHighlightLanguage(file.name))
  const requestPreparedPart = useCallback((requestId: number, part: number): boolean => {
    const worker = senderWorkerRef.current
    if (!worker) return false
    try {
      worker.postMessage({ type: "copyPreparedPart", requestId, part })
      return true
    } catch {
      return false
    }
  }, [])
  const apngController = useApngExportController({
    activePartRef,
    file,
    partCount,
    requestPreparedPart,
    settings,
  })
  const cancelApng = apngController.cancel
  const handlePreparedPart = apngController.handlePreparedPart

  /** Stable handle for the segment navigation bar; routes to the live stream. */
  const switchPart = useCallback((part: number) => switchPartRef.current(part), [])

  useEffect(() => {
    if (!error) {
      reportedErrorRef.current = undefined
      return
    }
    if (!onError || reportedErrorRef.current === error) return
    reportedErrorRef.current = error
    onError(new Error(error))
  }, [error, onError])

  useEffect(() => {
    let current = true
    setPreparedFile(undefined)
    setError(undefined)
    setStreamInfo(undefined)
    setStreamReady(false)
    setRendererBackend("webgl2")
    setStatus("Preparing QR camera stream...")
    let worker: Worker
    try {
      worker = createOpticalSenderWorker()
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    senderWorkerRef.current = worker
    worker.onmessage = (event: MessageEvent<SenderWorkerOutput>) => {
      if (!current) return
      const message = event.data
      if (message.type === "prepared") {
        setPartCount(message.file.partCount)
        setCurrentPart(0)
        activePartRef.current = 0
        setPreparedFile(message.file)
      } else if (message.type === "error" && message.session === undefined) {
        setError(message.message)
      } else if (message.type === "preparedPart") {
        handlePreparedPart(message.requestId, message.part)
      } else {
        streamMessageRef.current?.(message)
      }
    }
    const fail = (message: string) => {
      if (current) setError(message || "The QR generator worker stopped unexpectedly.")
    }
    worker.onerror = (event) => fail(event.message)
    worker.onmessageerror = () => fail("The QR generator worker returned an unreadable message.")
    // Standalone HTML can itself be hosted in a file/data/blob opaque origin.
    // Safari cannot grant a worker access to a structured-cloned File there,
    // so every standalone variant transfers one complete ArrayBuffer instead.
    const prepareInput =
      configuredWasmVariant !== "auto" || window.location.protocol === "file:"
        ? readFileBytes(file).then((bytes) => {
            const data = bytes.buffer
            return {
              message: { type: "prepareBytes" as const, name: file.name, mediaType, data },
              transfer: [data] as Transferable[],
            }
          })
        : Promise.resolve({
            message: { type: "prepare" as const, file, mediaType },
            transfer: undefined,
          })
    const zstdEncoderModule = isOpticalCompressionCandidate(file.name, file.type, file.size)
      ? loadZstdEncoderWasmModule(file.size)
      : Promise.resolve(undefined)
    void Promise.all([loadNanoRQCodecModule(), loadXXHashWasmModule(), zstdEncoderModule, prepareInput])
      .then(([module, xxhashWasmModule, zstdEncoderWasmModule, input]) => {
        if (!current) return
        worker.postMessage({
          type: "init",
          wasmModule: module,
          xxhashWasmModule,
          ...(zstdEncoderWasmModule ? { zstdEncoderWasmModule } : {}),
        })
        worker.postMessage(input.message, input.transfer ?? [])
      })
      .catch((cause) => fail(errorMessage(cause)))
    return () => {
      current = false
      streamMessageRef.current = null
      if (senderWorkerRef.current === worker) senderWorkerRef.current = null
      // Give the sender a short window to remove any disk-backed compressed
      // payload before terminating it. The timeout still guarantees cleanup
      // cannot leave a replaced/unmounted stream worker running indefinitely.
      let terminated = false
      const terminate = () => {
        if (terminated) return
        terminated = true
        clearTimeout(timeout)
        worker.terminate()
      }
      const timeout = setTimeout(terminate, 2_000)
      worker.onmessage = (event: MessageEvent<SenderWorkerOutput>) => {
        if (event.data.type === "disposed") terminate()
      }
      worker.onerror = terminate
      worker.onmessageerror = terminate
      try {
        worker.postMessage({ type: "dispose" })
      } catch {
        terminate()
      }
    }
  }, [file, handlePreparedPart, mediaType])

  useEffect(() => {
    fullscreenRef.current = isFullscreen
    resizeDisplayRef.current?.()
  }, [isFullscreen])

  useEffect(() => {
    if (!isFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [isFullscreen])

  useEffect(() => {
    const wakeLock = new P2PWakeLock(() => undefined)
    void wakeLock.start()
    return () => {
      void wakeLock.stop()
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const fallbackCanvas = fallbackCanvasRef.current
    const stage = stageRef.current
    const worker = senderWorkerRef.current
    if (!preparedFile || !canvas || !fallbackCanvas || !stage || !worker) return

    setError(undefined)
    setStreamInfo(undefined)
    setStreamReady(false)
    setStatus("Preparing QR camera stream...")

    const { txFps, frameBytes, ecc, gridCodes } = settings

    // frameBytes/ECC rebuild the RaptorQ codec in the worker and fall back to
    // part 0; playback-only settings (FPS/layout) keep the current part.
    const codecKey = `${frameBytes}:${ecc}`
    if (lastCodecRef.current !== codecKey) {
      lastCodecRef.current = codecKey
      activePartRef.current = 0
      setCurrentPart(0)
    }
    const partCountField = preparedFile.partCount - 1
    if (!fitsInOneStream(preparedFile.containerSize, frameBytes, partCountField)) {
      const suggestion = smallestSufficientFrameSize(
        preparedFile.containerSize,
        frameBytesOptionsForEcc(ecc),
        partCountField,
      )
      const resolution = suggestion
        ? `Raise Bytes / Frame to ${suggestion} or more.`
        : `No offered frame size fits at ECC ${ecc}; lower ECC or choose a smaller file.`
      setError(
        `${formatSize(preparedFile.containerSize)} needs ${sourceSymbolCount(preparedFile.containerSize, frameBytes, partCountField).toLocaleString()} ` +
          `source symbols, but one RFC 6330 source block can contain only ${MAX_SOURCE_SYMBOLS.toLocaleString()}. ` +
          resolution,
      )
      return
    }

    const playback = new OpticalPlaybackSession({
      canvas,
      fallbackCanvas,
      stage,
      worker,
      session: ++streamSessionRef.current,
      frameBytes,
      ecc,
      txFps,
      gridCodes,
      partCount,
      initialPart: activePartRef.current,
      fileName: file.name,
      isFullscreen: () => fullscreenRef.current,
      onError: (cause) => setError(errorMessage(cause)),
      onReady: () => setStreamReady(true),
      onRendererBackend: setRendererBackend,
      onStatus: setStatus,
      onStreamInfo: (version) => setStreamInfo({ version }),
    })
    const switchPart = (target: number) => {
      if (!playback.switchPart(target)) return
      cancelApng()
      activePartRef.current = target
      setCurrentPart(target)
    }
    resizeDisplayRef.current = playback.resize
    switchPartRef.current = switchPart
    streamMessageRef.current = playback.handleMessage
    playback.start()

    return () => {
      resizeDisplayRef.current = null
      if (streamMessageRef.current === playback.handleMessage) streamMessageRef.current = null
      if (switchPartRef.current === switchPart) switchPartRef.current = () => undefined
      playback.stop()
    }
  }, [cancelApng, file.name, partCount, preparedFile, settings])

  return {
    apng: apngController,
    canvasRef,
    fallbackCanvasRef,
    currentPart,
    error,
    isFullscreen,
    partCount,
    preparedFile,
    rendererBackend,
    setIsFullscreen,
    stageRef,
    status,
    streamInfo,
    streamReady,
    switchPart,
  }
}
