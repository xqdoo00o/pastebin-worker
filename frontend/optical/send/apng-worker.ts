import { initializeNanoRQ } from "../shared/nanorq-runtime.js"
import type { PackedOpticalFile } from "../shared/protocol.js"
import type { ApngWorkerInput, ApngWorkerOutput } from "../shared/worker-messages.js"
import { exportPreparedApng } from "./apng-export.js"
import { errorMessage } from "../../utils/errors.js"

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ApngWorkerInput>) => void) | null
  postMessage(message: ApngWorkerOutput, transfer?: Transferable[]): void
}

let pendingChunkAck: (() => void) | undefined

function sendChunks(parts: Uint8Array<ArrayBuffer>[]): Promise<void> {
  if (pendingChunkAck) throw new Error("An APNG chunk batch is already in flight.")
  return new Promise((resolve, reject) => {
    pendingChunkAck = resolve
    try {
      ctx.postMessage({ type: "chunks", parts }, [...new Set(parts.map((part) => part.buffer))])
    } catch (error) {
      pendingChunkAck = undefined
      reject(new Error(errorMessage(error)))
    }
  })
}

async function exportApng(message: Extract<ApngWorkerInput, { type: "export" }>): Promise<void> {
  try {
    await initializeNanoRQ(message.wasmModule)
    const partIndex = message.partIndex ?? 0
    const parts: (PackedOpticalFile | undefined)[] = Array.from({ length: partIndex + 1 })
    parts[partIndex] = message.part
    const result = await exportPreparedApng(
      parts,
      message.fileName,
      message,
      (completed, total) => {
        ctx.postMessage({ type: "progress", completed, total })
      },
      sendChunks,
    )
    ctx.postMessage({ type: "done", ...result })
  } catch (error) {
    ctx.postMessage({ type: "error", message: errorMessage(error) })
  }
}

ctx.onmessage = (event) => {
  if (event.data.type === "export") void exportApng(event.data)
  else {
    const resolve = pendingChunkAck
    pendingChunkAck = undefined
    resolve?.()
  }
}
