import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react"
import type { PackedOpticalFile } from "../../optical/shared/protocol.js"
import type { OpticalTransferSettings } from "../../optical/shared/settings.js"
import type { ApngWorkerInput, ApngWorkerOutput } from "../../optical/shared/worker-messages.js"
import { loadNanoRQCodecModule } from "../../optical/shared/wasm-module.js"
import { createApngExportWorker } from "./worker-factory.js"
import { errorMessage } from "../errors.js"
import { downloadBlob } from "../download.js"
import { disposeWorker } from "../workerLifecycle.js"
import { StreamedFileCollector } from "../streamedOutput.js"

export interface OpticalApngExportController {
  cancel: () => void
  error?: string
  isExporting: boolean
  percent: number
  progress?: { completed: number; total: number }
  start: (extraPercent: number, qrScale: number) => void
  status?: string
}

interface UseApngExportControllerOptions {
  activePartRef: MutableRefObject<number>
  file: File
  partCount: number
  requestPreparedPart: (requestId: number, part: number) => boolean
  settings: OpticalTransferSettings
}

interface PendingExport {
  part?: PackedOpticalFile
  request: Omit<Extract<ApngWorkerInput, { type: "export" }>, "wasmModule" | "part">
  requestId: number
  wasmModule?: WebAssembly.Module
  worker: Worker
}

/** Owns a short-lived APNG worker so its CPU-heavy encoding cannot starve the
 * long-lived worker that continuously supplies QR frames to the camera view. */
export function useApngExportController({
  activePartRef,
  file,
  partCount,
  requestPreparedPart,
  settings,
}: UseApngExportControllerOptions) {
  const [progress, setProgress] = useState<{ completed: number; total: number }>()
  const [status, setStatus] = useState<string>()
  const [error, setError] = useState<string>()
  const workerRef = useRef<Worker | null>(null)
  const outputRef = useRef<StreamedFileCollector | null>(null)
  const pendingRef = useRef<PendingExport | undefined>(undefined)
  const nextRequestIdRef = useRef(0)

  const disposeCurrent = useCallback(() => {
    const worker = workerRef.current
    const output = outputRef.current
    workerRef.current = null
    outputRef.current = null
    pendingRef.current = undefined
    if (worker) disposeWorker(worker)
    if (output) void output.abort().catch(() => undefined)
  }, [])

  const postPendingExport = useCallback(() => {
    const pending = pendingRef.current
    if (!pending?.part || !pending.wasmModule || workerRef.current !== pending.worker) return
    pendingRef.current = undefined
    try {
      pending.worker.postMessage({ ...pending.request, wasmModule: pending.wasmModule, part: pending.part }, [
        pending.part.container.buffer,
      ])
    } catch (cause) {
      disposeCurrent()
      setProgress(undefined)
      setStatus(undefined)
      setError(errorMessage(cause))
    }
  }, [disposeCurrent])

  useEffect(() => {
    setProgress(undefined)
    setStatus(undefined)
    setError(undefined)
    return disposeCurrent
  }, [disposeCurrent, file, settings])

  const cancel = useCallback(() => {
    if (!workerRef.current) return
    disposeCurrent()
    setProgress(undefined)
    setError(undefined)
    setStatus("APNG export cancelled.")
  }, [disposeCurrent])

  const handlePreparedPart = useCallback(
    (requestId: number, part: PackedOpticalFile): boolean => {
      const pending = pendingRef.current
      if (pending?.requestId !== requestId) return true
      pending.part = part
      postPendingExport()
      return true
    },
    [postPendingExport],
  )

  const handlePreparedPartError = useCallback(
    (requestId: number, message: string): void => {
      if (pendingRef.current?.requestId !== requestId) return
      disposeCurrent()
      setProgress(undefined)
      setStatus(undefined)
      setError(message)
    },
    [disposeCurrent],
  )

  const start = useCallback(
    (extraPercent: number, qrScale: number) => {
      if (workerRef.current) return
      setProgress({ completed: 0, total: 0 })
      setStatus(undefined)
      setError(undefined)

      let worker: Worker
      try {
        worker = createApngExportWorker()
      } catch (cause) {
        setProgress(undefined)
        setError(errorMessage(cause))
        return
      }
      workerRef.current = worker
      const output = new StreamedFileCollector({ purpose: "optical" })
      outputRef.current = output
      const requestId = ++nextRequestIdRef.current
      const selectedPart = partCount > 1 ? activePartRef.current : 0
      const request: Omit<Extract<ApngWorkerInput, { type: "export" }>, "wasmModule" | "part"> = {
        type: "export",
        fileName: file.name,
        frameBytes: settings.frameBytes,
        ecc: settings.ecc,
        gridCodes: settings.gridCodes,
        txFps: settings.txFps,
        extraPercent,
        qrScale,
        ...(partCount > 1 ? { partIndex: selectedPart } : {}),
      }
      pendingRef.current = { requestId, request, worker }

      const fail = (message: string) => {
        if (workerRef.current !== worker) return
        disposeCurrent()
        setProgress(undefined)
        setStatus(undefined)
        setError(message || "The APNG export worker stopped unexpectedly.")
      }
      worker.onmessage = (event: MessageEvent<ApngWorkerOutput>) => {
        if (workerRef.current !== worker) return
        const message = event.data
        if (message.type === "progress") {
          setProgress({ completed: message.completed, total: message.total })
          return
        }
        if (message.type === "chunks") {
          void output
            .append(message.parts)
            .then(() => {
              if (workerRef.current === worker) worker.postMessage({ type: "chunksAck" })
            })
            .catch((cause) => fail(errorMessage(cause)))
          return
        }
        if (message.type === "error") {
          fail(message.message)
          return
        }

        void output
          .finish(message.filename, "image/png")
          .then((stored) => {
            if (workerRef.current !== worker) {
              void stored.cleanup?.().catch(() => undefined)
              return
            }
            outputRef.current = null
            disposeCurrent()
            setProgress(undefined)
            try {
              downloadBlob(stored.file, message.filename, stored.deferCleanup ? 60_000 : 1000)
              stored.deferCleanup?.()
              setStatus(
                `Exported ${message.width.toLocaleString()}×${message.height.toLocaleString()} APNG with ${message.frames.toLocaleString()} frames containing ${message.symbols.toLocaleString()} QR symbols.`,
              )
            } catch (cause) {
              void stored.cleanup?.().catch(() => undefined)
              setStatus(undefined)
              setError(errorMessage(cause))
            }
          })
          .catch((cause) => fail(errorMessage(cause)))
      }
      worker.onerror = (event) => fail(event.message)
      worker.onmessageerror = () => fail("The APNG export worker returned an unreadable message.")

      void loadNanoRQCodecModule()
        .then((wasmModule) => {
          const pending = pendingRef.current
          if (pending?.worker !== worker) return
          pending.wasmModule = wasmModule
          postPendingExport()
        })
        .catch((cause) => fail(errorMessage(cause)))

      if (!requestPreparedPart(requestId, selectedPart)) {
        fail("The optical file is not prepared.")
      }
    },
    [activePartRef, disposeCurrent, file.name, partCount, postPendingExport, requestPreparedPart, settings],
  )

  return {
    cancel,
    error,
    isExporting: progress !== undefined,
    percent: progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0,
    progress,
    start,
    status,
    handlePreparedPart,
    handlePreparedPartError,
  }
}
