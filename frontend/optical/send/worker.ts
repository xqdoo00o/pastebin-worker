import { monochromeByteLength, qrMonochrome } from "../shared/monochrome.js"
import { OpticalQrFrameEncoder } from "../shared/qr-frame-encoder.js"
import { TRANSFER_QR_MARGIN, type QrErrorCorrection } from "../shared/qr.js"
import { initializeNanoRQ } from "../shared/nanorq-runtime.js"
import { initializeZstdEncoder } from "../../wasm/zstd-runtime.js"
import { initializeXXHash } from "../../wasm/xxhash-runtime.js"
import type { PackedOpticalFile } from "../shared/protocol.js"
import type { SenderWorkerInput, SenderWorkerOutput } from "../shared/worker-messages.js"
import {
  prepareOpticalPayload,
  type OpticalMemoryFile,
  type PreparedOpticalPayload,
  type OpticalTransferParts,
} from "./prepared-transfer.js"
import { errorMessage } from "../../utils/errors.js"

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<SenderWorkerInput>) => void) | null
  postMessage(message: SenderWorkerOutput, transfer?: Transferable[]): void
}

interface StreamState {
  session: number
  frameBytes: number
  ecc: QrErrorCorrection
  encoder: OpticalQrFrameEncoder
  nextSequence: number
  recycledBuffers: ArrayBuffer[]
  /** Index of the part currently being encoded. */
  currentPart: number
  /** Exact transmitted payload bytes in the current part. */
  partBytes: number
}

let preparedPayload: PreparedOpticalPayload | undefined
let preparedTransfer: OpticalTransferParts | undefined
interface CachedPart {
  controller: AbortController
  promise: Promise<PackedOpticalFile>
}

const partCache = new Map<number, CachedPart>()
// A prepared container may be 64 MiB. Keep automatic prefetch bounded because
// part navigation is manual and the active container already lives in WASM.
const MAX_PREFETCH_CONTAINER_BYTES = 16 * 1024 * 1024
let stream: StreamState | undefined
let codecReady: Promise<void> | undefined
let codecInitializationErrorReported = false
let codecWork = Promise.resolve()
let prepareWork = Promise.resolve()
let partLoadWork = Promise.resolve()
// Keep cancellation alive through lazy hashing and part reads, not just compression.
let payloadController: AbortController | undefined

function reportCodecInitializationError(error: unknown): void {
  if (codecInitializationErrorReported) return
  codecInitializationErrorReported = true
  ctx.postMessage({ type: "error", message: errorMessage(error) })
}

function initializedCodecs(): Promise<void> {
  return codecReady ?? Promise.reject(new Error("The optical codecs have not been initialized."))
}

async function prepare(file: File | OpticalMemoryFile, mediaType?: string): Promise<void> {
  payloadController?.abort()
  const controller = new AbortController()
  payloadController = controller
  try {
    await releasePreparedTransfer()
    const next = await prepareOpticalPayload(file, { signal: controller.signal, mediaType })
    if (controller.signal.aborted) {
      await next.cleanup()
      return
    }
    preparedPayload = next
    ctx.postMessage({ type: "payloadReady" })
  } catch (error) {
    if (controller.signal.aborted) return
    preparedTransfer = undefined
    clearPartCache()
    stream?.encoder.free()
    stream = undefined
    ctx.postMessage({ type: "error", message: errorMessage(error) })
  }
}

async function releasePreparedTransfer(): Promise<void> {
  stream?.encoder.free()
  stream = undefined
  clearPartCache()
  const previous = preparedPayload
  preparedPayload = undefined
  preparedTransfer = undefined
  await partLoadWork
  await previous?.cleanup()
}

/** Replace only part views, preserving the compressed source and whole-file hash. */
async function partition(message: Extract<SenderWorkerInput, { type: "partition" }>): Promise<void> {
  await prepareWork
  stream?.encoder.free()
  stream = undefined
  preparedTransfer = undefined
  clearPartCache()
  await partLoadWork
  if (!preparedPayload) throw new Error("The optical file is not prepared.")
  preparedTransfer = await preparedPayload.partition(message.partPayloadSize)
  ctx.postMessage({
    type: "prepared",
    requestId: message.requestId,
    partPayloadSize: message.partPayloadSize,
    file: preparedTransfer.summary,
  })
}

function clearPartCache(): void {
  for (const cached of partCache.values()) cached.controller.abort()
  partCache.clear()
}

function cachedPart(index: number): Promise<PackedOpticalFile> {
  const existing = partCache.get(index)
  if (existing) return existing.promise
  const transfer = preparedTransfer
  if (!transfer) return Promise.reject(new Error("The optical file is not prepared."))
  const controller = new AbortController()
  // Keep reads serialized so navigation never overlaps two large container
  // allocations. Chunked source reads let retainParts abort stale prefetches
  // between chunks rather than finishing an unused 64 MiB part.
  const pending = partLoadWork.then(async () => {
    controller.signal.throwIfAborted()
    if (preparedTransfer !== transfer || partCache.get(index)?.controller !== controller) {
      throw new DOMException("The optical part is no longer needed.", "AbortError")
    }
    return await transfer.getPart(index, controller.signal)
  })
  const cached: CachedPart = { controller, promise: pending }
  partLoadWork = pending.then(
    () => undefined,
    () => undefined,
  )
  partCache.set(index, cached)
  void pending.catch(() => {
    if (partCache.get(index) === cached) partCache.delete(index)
  })
  return pending
}

function retainParts(...indices: number[]): void {
  const retained = new Set(indices)
  for (const [index, cached] of partCache) {
    if (retained.has(index)) continue
    partCache.delete(index)
    cached.controller.abort()
  }
}

function prefetchNextPart(index: number): void {
  const next = index + 1
  if (
    !preparedTransfer ||
    next >= preparedTransfer.summary.partCount ||
    preparedTransfer.summary.containerSize > MAX_PREFETCH_CONTAINER_BYTES
  ) {
    return
  }
  void cachedPart(next).catch(() => undefined)
}

async function configure(message: Extract<SenderWorkerInput, { type: "configure" }>): Promise<void> {
  if (!preparedTransfer) {
    ctx.postMessage({ type: "error", session: message.session, message: "The optical file is not prepared." })
    return
  }
  // Playback-only changes (FPS/grid) restart the UI session but send the same
  // codec configuration. Keep the already-precalculated RaptorQ matrix and QR
  // version in that common case; only payload shape/ECC changes rebuild it.
  if (stream?.frameBytes === message.frameBytes && stream.ecc === message.ecc) {
    stream.session = message.session
    return
  }

  stream?.encoder.free()
  retainParts(0)
  const first = await cachedPart(0)
  const encoder = new OpticalQrFrameEncoder({
    container: first.container,
    containerTag: first.containerTag,
    part: first.part,
    frameBytes: message.frameBytes,
    ecc: message.ecc,
  })
  stream = {
    session: message.session,
    frameBytes: message.frameBytes,
    ecc: message.ecc,
    encoder,
    nextSequence: 0,
    recycledBuffers: [],
    currentPart: 0,
    partBytes: first.transmittedSize,
  }
  // NanoRQ copied the container into WASM; retain only the prefetched next
  // part on the JS heap rather than keeping a duplicate of the active one.
  partCache.delete(0)
  retainParts(1)
  prefetchNextPart(0)
}

/** Rebuild the encoder for a different part of the same prepared transfer. */
async function switchPart(message: Extract<SenderWorkerInput, { type: "switchPart" }>): Promise<void> {
  const current = stream
  if (current?.session !== message.session || !preparedTransfer) return
  const target = message.part
  if (
    !Number.isInteger(target) ||
    target < 0 ||
    target >= preparedTransfer.summary.partCount ||
    target === current.currentPart
  ) {
    return
  }

  retainParts(target)
  const next = await cachedPart(target)
  current.encoder.free()
  current.encoder = new OpticalQrFrameEncoder({
    container: next.container,
    containerTag: next.containerTag,
    part: next.part,
    frameBytes: current.frameBytes,
    ecc: current.ecc,
  })
  current.currentPart = target
  current.partBytes = next.transmittedSize
  current.nextSequence = 0
  partCache.delete(target)
  retainParts(target + 1)
  prefetchNextPart(target)
}

function generateBatch(message: Extract<SenderWorkerInput, { type: "generate" }>): void {
  const current = stream
  if (current?.session !== message.session) return
  try {
    current.recycledBuffers.push(...message.recycledBuffers)
    const count = Math.max(1, Math.floor(message.count))
    const monochromeBuffers: ArrayBuffer[] = []
    for (let index = 0; index < count; index++) {
      const seq = current.nextSequence++
      const qr = current.encoder.encode(seq)
      const cell = qr.size + 2 * TRANSFER_QR_MARGIN
      const planeBytes = monochromeByteLength(cell, cell)
      let reusable: Uint8Array<ArrayBuffer> | undefined
      while (current.recycledBuffers.length > 0) {
        const buffer = current.recycledBuffers.pop()!
        if (buffer.byteLength === planeBytes) {
          reusable = new Uint8Array(buffer)
          break
        }
      }
      const image = qrMonochrome(qr, TRANSFER_QR_MARGIN, reusable?.subarray(0, planeBytes))
      monochromeBuffers.push(image.data.buffer)
    }
    ctx.postMessage(
      {
        type: "batch",
        session: current.session,
        monochromeBuffers,
        version: current.encoder.version!,
        modules: current.encoder.modules,
        part: current.currentPart,
        partBytes: current.partBytes,
      },
      monochromeBuffers,
    )
  } catch (error) {
    ctx.postMessage({ type: "error", session: current.session, message: errorMessage(error) })
  }
}

/** Materialize only the requested part and transfer its JS buffer to the APNG
 * worker path. RaptorQ already copied the active container into WASM, so the
 * sender can drop this cache entry without cloning another full part. */
async function copyPreparedPart(message: Extract<SenderWorkerInput, { type: "copyPreparedPart" }>): Promise<void> {
  if (!preparedTransfer || message.part < 0 || message.part >= preparedTransfer.summary.partCount) {
    throw new Error("The requested optical part is not prepared.")
  }
  retainParts(message.part)
  const part = await cachedPart(message.part)
  partCache.delete(message.part)
  ctx.postMessage({ type: "preparedPart", requestId: message.requestId, part }, [part.container.buffer])
}

async function dispose(): Promise<void> {
  payloadController?.abort()
  await prepareWork.catch(() => undefined)
  await releasePreparedTransfer()
  ctx.postMessage({ type: "disposed" })
}

ctx.onmessage = (event) => {
  const message = event.data
  if (message.type === "init") {
    codecReady ??= Promise.all([
      initializeNanoRQ(message.wasmModule),
      initializeXXHash(message.xxhashWasmModule),
      // The page stream-compiled hosted WASM (or buffered an inlined
      // standalone asset) and shares the resulting Module with this worker.
      message.zstdEncoderWasmModule ? initializeZstdEncoder(message.zstdEncoderWasmModule) : Promise.resolve(),
    ]).then(() => undefined)
    void codecReady.catch(reportCodecInitializationError)
  } else if (message.type === "prepare") {
    prepareWork = initializedCodecs()
      .then(() => prepare(message.file, message.mediaType))
      .catch(reportCodecInitializationError)
  } else if (message.type === "prepareBytes") {
    prepareWork = initializedCodecs()
      .then(() => prepare({ name: message.name, type: message.mediaType, data: message.data }))
      .catch(reportCodecInitializationError)
  } else if (message.type === "dispose") {
    payloadController?.abort()
    clearPartCache()
    codecWork = codecWork.then(dispose).catch((error) => {
      ctx.postMessage({ type: "error", message: errorMessage(error) })
    })
  } else {
    // WASM initialization is asynchronous, while configure and the first
    // generate request arrive back-to-back. Serialize them to preserve the
    // sender's message order during that one-time startup.
    codecWork = codecWork
      .then(async () => {
        await initializedCodecs()
        if (message.type === "partition") await partition(message)
        else if (message.type === "configure") await configure(message)
        else if (message.type === "switchPart") await switchPart(message)
        else if (message.type === "copyPreparedPart") await copyPreparedPart(message)
        else generateBatch(message)
      })
      .catch((error) => {
        if (message.type === "copyPreparedPart") {
          ctx.postMessage({ type: "preparedPartError", requestId: message.requestId, message: errorMessage(error) })
          return
        }
        ctx.postMessage({
          type: "error",
          session: "session" in message ? message.session : undefined,
          requestId: message.type === "partition" ? message.requestId : undefined,
          message: errorMessage(error),
        })
      })
  }
}
