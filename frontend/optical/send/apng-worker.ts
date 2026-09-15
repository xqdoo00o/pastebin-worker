import { initializeNanoRQ } from "../shared/nanorq-runtime.js"
import type { PackedOpticalFile } from "../shared/protocol.js"
import type { ApngWorkerInput, ApngWorkerOutput } from "../shared/worker-messages.js"
import { exportPreparedApng } from "./apng-export.js"
import { errorMessage } from "../../utils/errors.js"

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ApngWorkerInput>) => void) | null
  postMessage(message: ApngWorkerOutput): void
}

async function exportApng(message: Extract<ApngWorkerInput, { type: "export" }>): Promise<void> {
  try {
    await initializeNanoRQ(message.wasmModule)
    const partIndex = message.partIndex ?? 0
    const parts: (PackedOpticalFile | undefined)[] = Array.from({ length: partIndex + 1 })
    parts[partIndex] = message.part
    const result = await exportPreparedApng(parts, message.fileName, message, (completed, total) => {
      ctx.postMessage({ type: "progress", completed, total })
    })
    ctx.postMessage({ type: "done", ...result })
  } catch (error) {
    ctx.postMessage({ type: "error", message: errorMessage(error) })
  }
}

ctx.onmessage = (event) => {
  if (event.data.type === "export") void exportApng(event.data)
}
