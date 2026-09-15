import {
  streamZipFiles,
  type ArchiveCompression,
  type ArchiveWorkerRequest,
  type ArchiveWorkerResponse,
} from "./archiveCore.js"
import { initializeZstdEncoder } from "../wasm/zstd-runtime.js"
import { transferableBuffer } from "../../shared/bytes.js"
import { errorMessage } from "./errors.js"

let started = false
let nextChunkId = 1
let pendingAck: { id: number; resolve: () => void } | undefined
let initialization: Promise<void> = Promise.resolve()

function sendChunk(chunk: Uint8Array): Promise<void> {
  const id = nextChunkId++
  const data = transferableBuffer(chunk)
  return new Promise<void>((resolve) => {
    pendingAck = { id, resolve }
    const response: ArchiveWorkerResponse = { type: "chunk", id, data }
    self.postMessage(response, { transfer: [data] })
  })
}

function postError(error: unknown): void {
  const response: ArchiveWorkerResponse = {
    type: "error",
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: errorMessage(error),
    },
  }
  self.postMessage(response)
}

async function buildArchive(files: File[], compression: ArchiveCompression, useFflateWorker: boolean): Promise<void> {
  try {
    await initialization
    await streamZipFiles(files, sendChunk, { compression, useWebWorkers: useFflateWorker })
    const response: ArchiveWorkerResponse = { type: "complete" }
    self.postMessage(response)
  } catch (error) {
    postError(error)
  }
}

self.onmessage = (event: MessageEvent<ArchiveWorkerRequest>) => {
  const message = event.data
  if (message.type === "chunk-ack") {
    if (pendingAck?.id !== message.id) return
    const { resolve } = pendingAck
    pendingAck = undefined
    resolve()
    return
  }

  if (message.type === "init") {
    initialization = message.zstdEncoderWasmModule
      ? initializeZstdEncoder(message.zstdEncoderWasmModule)
      : Promise.resolve()
    void initialization.catch(() => undefined)
    return
  }

  if (started) {
    postError(new Error("Archive worker has already started"))
    return
  }
  started = true
  void buildArchive(message.files, message.compression, message.useFflateWorker)
}
