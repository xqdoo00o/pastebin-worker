// Dedicated RFC 6330 decoder. Matrix recovery and WASM initialization stay off
// the UI thread that drives camera capture and paints the preview.

import {
  RaptorQDecoder,
  expectedTransferVerdict,
  type ExpectedOpticalTransfer,
  type FountainFramesMessage,
  type FountainSnapshot,
  type FountainWorkerInput,
  type FountainWorkerOutput,
} from "../shared/fountain.js"
import {
  frameVerdictMessage,
  getXXH3,
  inspectFrame,
  streamIdentity,
  type DecodedFrameHeader,
} from "../shared/protocol.js"
import { initializeNanoRQ } from "../shared/nanorq-runtime.js"
import { initializeXXHash } from "../../wasm/xxhash-runtime.js"
import { errorMessage } from "../../utils/errors.js"

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<FountainWorkerInput>) => void) | null
  postMessage(message: FountainWorkerOutput, transfer?: Transferable[]): void
}

const PROGRESS_INTERVAL_MS = 250

let decoder: RaptorQDecoder | null = null
let identity = ""
let header: DecodedFrameHeader | null = null
let lastProgressAt = -Infinity
let completed = false
let verdictMessage: string | null = null
let codecReady: Promise<unknown> | undefined
let codecWork = Promise.resolve()
let expectedTransfer: ExpectedOpticalTransfer | null = null
const framePorts = new Map<number, MessagePort>()

function snapshot(): FountainSnapshot {
  const d = decoder!
  return {
    identity,
    k: d.k,
    symbolLen: d.symbolLen,
    framesNew: d.framesNew,
  }
}

function sameStream(a: DecodedFrameHeader | null, b: DecodedFrameHeader): boolean {
  return (
    a !== null &&
    a.packetLen === b.packetLen &&
    a.totalLen === b.totalLen &&
    a.containerTag === b.containerTag &&
    a.part.index === b.part.index &&
    a.part.count === b.part.count &&
    a.part.transferId === b.part.transferId
  )
}

async function decodeFrame(buffer: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(buffer)
  const inspected = inspectFrame(bytes)
  if (!("frame" in inspected)) {
    const message = frameVerdictMessage(inspected.verdict)
    if (message && message !== verdictMessage) {
      verdictMessage = message
      ctx.postMessage({ type: "verdict", message })
    }
    return
  }
  const parsed = inspected.frame
  const rejected = expectedTransferVerdict(parsed.header.part, expectedTransfer)
  if (rejected) {
    if (rejected !== verdictMessage) {
      verdictMessage = rejected
      ctx.postMessage({ type: "verdict", message: rejected, reason: "transfer" })
    }
    return
  }
  if (verdictMessage !== null) {
    verdictMessage = null
    ctx.postMessage({ type: "verdict", message: null })
  }

  // Decode-worker messages already in flight can arrive after completion.
  // Ignore the completed identity without rebuilding its matrix.
  if (completed && sameStream(header, parsed.header)) return

  // Once collection has started, another valid optical stream in the same
  // camera view must not repeatedly destroy the current RaptorQ matrix.
  if (decoder && !sameStream(header, parsed.header)) return

  const started = !decoder || !sameStream(header, parsed.header)
  if (started) {
    decoder?.free()
    header = parsed.header
    // Identity is UI snapshot data; compare numeric header fields in the hot
    // path and materialize this string only when a new stream actually starts.
    identity = streamIdentity(parsed.header)
    decoder = new RaptorQDecoder(parsed.header.packetLen, parsed.header.totalLen)
    lastProgressAt = -Infinity
    completed = false
  }

  decoder!.addFrame(parsed.block)

  if (decoder!.isComplete) {
    const payload = decoder!.assemble()!
    completed = true
    const finalSnapshot = snapshot()
    decoder!.free()
    decoder = null
    if ((await getXXH3(payload)) !== parsed.header.containerTag) {
      ctx.postMessage({ type: "error", message: "The recovered DCF container XXH3 tag did not match." })
      return
    }
    // The WASM decoder returns an exact, offset-zero buffer, so transfer it directly
    // instead of briefly holding a second full-file copy.
    const output = payload.buffer as ArrayBuffer
    ctx.postMessage(
      {
        type: "complete",
        snapshot: finalSnapshot,
        part: parsed.header.part,
        container: output,
      },
      [output],
    )
    return
  }

  const now = performance.now()
  if (started || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
    lastProgressAt = now
    ctx.postMessage({ type: "progress", started, snapshot: snapshot() })
  }
}

function reportCodecError(cause: unknown): void {
  ctx.postMessage({ type: "error", message: `Optical decoder: ${errorMessage(cause)}` })
}

function enqueueFrames(buffers: ArrayBuffer[]): void {
  if (buffers.length === 0) return
  codecWork = codecWork
    .then(async () => {
      if (!codecReady) throw new Error("The optical codecs have not been initialized.")
      await codecReady
      for (const buffer of buffers) await decodeFrame(buffer)
    })
    .catch(reportCodecError)
    .finally(() => ctx.postMessage({ type: "processed", count: buffers.length }))
}

function isFramesMessage(value: unknown): value is FountainFramesMessage {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<FountainFramesMessage>
  return candidate.type === "frames" && Array.isArray(candidate.buffers)
}

function connectFramePort(connectionId: number, port: MessagePort): void {
  const previous = framePorts.get(connectionId)
  previous?.close()
  framePorts.set(connectionId, port)
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (framePorts.get(connectionId) !== port) return
    if (!isFramesMessage(event.data)) {
      ctx.postMessage({ type: "error", message: "QR decoder channel returned invalid data." })
      return
    }
    enqueueFrames(event.data.buffers)
  }
  port.onmessageerror = () =>
    ctx.postMessage({ type: "error", message: "QR decoder channel returned unreadable data." })
  port.start()
}

function disconnectFramePort(connectionId: number): void {
  const port = framePorts.get(connectionId)
  if (!port) return
  framePorts.delete(connectionId)
  port.onmessage = null
  port.onmessageerror = null
  port.close()
}

ctx.onmessage = (event) => {
  const message = event.data
  if (message.type === "init") {
    if (!codecReady) {
      codecReady = Promise.all([initializeNanoRQ(message.wasmModule), initializeXXHash(message.xxhashWasmModule)])
      void codecReady
        .then(() => ctx.postMessage({ type: "ready" }))
        .catch((cause) => {
          ctx.postMessage({ type: "error", message: `Optical decoder: ${errorMessage(cause)}` })
        })
    }
    return
  }
  if (message.type === "connect") connectFramePort(message.connectionId, message.port)
  else if (message.type === "disconnect") disconnectFramePort(message.connectionId)
  else expectedTransfer = message.expected
}
