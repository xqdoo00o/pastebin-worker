import type { ApngParserWorkerInput, ApngParserWorkerOutput } from "../shared/worker-messages.js"
import { streamApngFrames } from "./apng.js"
import { errorMessage } from "../../utils/errors.js"

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ApngParserWorkerInput>) => void) | null
  postMessage(message: ApngParserWorkerOutput, transfer?: Transferable[]): void
}

let credits = 0
const creditWaiters: (() => void)[] = []
let started = false

function addCredit(): void {
  const waiter = creditWaiters.shift()
  if (waiter) waiter()
  else credits++
}

function takeCredit(): Promise<void> {
  if (credits > 0) {
    credits--
    return Promise.resolve()
  }
  return new Promise((resolve) => creditWaiters.push(resolve))
}

async function start(file: Blob | Uint8Array<ArrayBuffer>, initialCredits: number): Promise<void> {
  if (started) throw new Error("The APNG parser is already running.")
  if (!Number.isInteger(initialCredits) || initialCredits < 1) throw new Error("The APNG parser has no decode workers.")
  started = true
  credits = initialCredits
  try {
    const info = await streamApngFrames(file, async (frame) => {
      await takeCredit()
      ctx.postMessage(
        { type: "frame", ...frame },
        frame.compressed instanceof Uint8Array ? [frame.compressed.buffer] : undefined,
      )
    })
    ctx.postMessage({ type: "done", ...info })
  } catch (error) {
    ctx.postMessage({ type: "error", message: errorMessage(error) })
  }
}

ctx.onmessage = (event) => {
  if (event.data.type === "credit") addCredit()
  else if (event.data.type === "startBytes") void start(new Uint8Array(event.data.data), event.data.credits)
  else void start(event.data.file, event.data.credits)
}
