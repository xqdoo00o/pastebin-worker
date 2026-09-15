// QR decode worker: the project's source-built optical codec
// compiled to WASM. (Safari has
// never shipped BarcodeDetector — WebKit bug 281848 — so WASM is the only
// portable way.) One frame in flight per worker; the main thread drops frames
// when all workers are busy. Frames are disposable — the fountain doesn't care.
//
// Every accepted camera frame follows the Android receiver's simple path:
// copy the full image (preferably its Y plane) and run one QR-only readFull.

import OpticalCodec, { type OpticalModule } from "../codec/optical_codec.js"
import {
  isLumaVideoFormat,
  tightVideoFrameLayout,
  type LumaVideoFormat,
  type TightVideoFrameLayout,
} from "../shared/capture.js"
import type { FountainFramesMessage } from "../shared/fountain.js"
import type { DecodeWorkerOutput } from "../shared/worker-messages.js"
import { apngFrameGeometry, type OpticalApngMetadata } from "../shared/apng-format.js"
import { inflateApngFrameInto } from "./apng.js"
import { transferableBuffer } from "../../../shared/bytes.js"
import { errorMessage } from "../../utils/errors.js"

interface InitMessage {
  type: "init"
  wasmModule: WebAssembly.Module
  fountainPort: MessagePort
}

function isInitMessage(value: unknown): value is InitMessage {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<InitMessage>
  return (
    candidate.type === "init" &&
    candidate.wasmModule instanceof WebAssembly.Module &&
    typeof candidate.fountainPort?.postMessage === "function"
  )
}

let resolveInit!: (message: InitMessage) => void
const initReady = new Promise<InitMessage>((resolve) => {
  resolveInit = resolve
})
let fountainPort: MessagePort | undefined

const ready: Promise<OpticalModule> = initReady.then(({ wasmModule }) => {
  return OpticalCodec({
    instantiateWasm(imports, done) {
      const instance = new WebAssembly.Instance(wasmModule, imports)
      done(instance, wasmModule)
      return instance.exports
    },
  })
})

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(message: DecodeWorkerOutput, transfer?: Transferable[]): void
}

// One stable WASM input allocation per worker. The old path malloc/free'd on
// every frame; besides allocator churn, that prevented VideoFrame.copyTo()
// from writing straight into the decoder heap. It grows to the largest capture
// this worker has seen and is reclaimed when the worker is terminated.
let inputPtr = 0
let inputCapacity = 0
let inputView: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
let inputHeapBuffer: ArrayBufferLike | undefined

// WebCodecs camera frames are normally planar YUV. QR decoding needs only
// plane 0 (luminance), avoiding both WebKit's missing YUV -> RGBA conversion
// and the 4x-sized RGBA intermediate. copyTo still writes the native chroma
// planes after Y because WebCodecs has no single-plane copy option.
const tightLayoutRejected = new Set<LumaVideoFormat>()

function ensureInput(zx: OpticalModule, bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError("The capture buffer size is invalid.")
  if (inputCapacity < bytes) {
    const previousPtr = inputPtr
    inputPtr = 0
    inputCapacity = 0
    inputView = new Uint8Array(0)
    inputHeapBuffer = undefined
    if (previousPtr) zx._free(previousPtr)

    const nextPtr = zx._malloc(bytes)
    if (!nextPtr || nextPtr + bytes > zx.HEAPU8.length) {
      if (nextPtr) zx._free(nextPtr)
      throw new RangeError("The QR decoder does not have enough memory for this frame.")
    }
    inputPtr = nextPtr
    inputCapacity = bytes
  }
  // Decoder calls may grow WebAssembly.Memory and replace HEAPU8's backing
  // buffer. Refresh only after that happens; otherwise copyTo reuses one view.
  if (inputHeapBuffer !== zx.HEAPU8.buffer) {
    inputView = zx.HEAPU8.subarray(inputPtr, inputPtr + inputCapacity)
    inputHeapBuffer = zx.HEAPU8.buffer
  }
  return inputPtr
}

class CaptureReadError extends Error {}

type PixelKind = "rgba" | "bgrx" | "lum" | "module-grid-mono1"
type PackedVideoFormat = "RGBA" | "RGBX" | "BGRA" | "BGRX"
interface WasmPixels {
  ptr: number
  w: number
  h: number
  kind: PixelKind
  moduleGrid?: { qrVersion: number; columns: number; rows: number }
}

// A decode worker accepts only one frame at a time, so copyTo's mutable
// descriptors can be shared by every capture handled by this worker.
const copyRect = { x: 0, y: 0, width: 0, height: 0 }
const tightLumaLayout: TightVideoFrameLayout = { layout: [], byteLength: 0 }
const tightLumaOptions: VideoFrameCopyToOptions = { rect: copyRect, layout: tightLumaLayout.layout }
const nativeLumaOptions: VideoFrameCopyToOptions = { rect: copyRect }
const packedLayout = [{ offset: 0, stride: 0 }]
const packedOptions = {
  rect: copyRect,
  format: "RGBA",
  layout: packedLayout,
} as VideoFrameCopyToOptions & { format: PackedVideoFormat }

function setCopyRect(x: number, y: number, width: number, height: number): void {
  copyRect.x = x
  copyRect.y = y
  copyRect.width = width
  copyRect.height = height
}

async function videoFrameLumaIntoWasm(
  zx: OpticalModule,
  frame: VideoFrame,
  format: LumaVideoFormat,
  w: number,
  h: number,
  sx: number,
  sy: number,
): Promise<WasmPixels> {
  setCopyRect(sx, sy, w, h)
  let tightCopyRejected = false
  if (!tightLayoutRejected.has(format)) {
    const tight = tightVideoFrameLayout(format, w, h, tightLumaLayout)
    try {
      const ptr = ensureInput(zx, tight.byteLength)
      const layouts = await frame.copyTo(inputView, tightLumaOptions)
      const y = layouts[0]
      // The destination layout is authored here, so its offsets are where
      // copyTo actually wrote - as long as the implementation either echoed the
      // requested offsets or reported per-plane-relative zeros. Anything else
      // means it laid the destination out itself, and only the native path
      // knows those reported offsets. Using a stale assumption would silently
      // sample the luminance plane as chroma.
      const stridesMatch =
        layouts.length === tight.layout.length &&
        layouts.every((plane, index) => plane.stride === tight.layout[index]?.stride)
      const offsetsEchoed = layouts.every((plane, index) => plane.offset === tight.layout[index]?.offset)
      const offsetsPerPlane = layouts.every((plane) => plane.offset === 0)
      if (!stridesMatch || !(offsetsEchoed || offsetsPerPlane) || y?.offset !== 0 || y.stride !== w) {
        throw new Error("VideoFrame ignored the requested packed luminance layout")
      }
      return {
        ptr,
        w,
        h,
        kind: "lum",
      }
    } catch {
      // Older engines may reject the optional layout while sizing or copying.
      // Retry with their native layout; once that succeeds, skip this probe
      // forever in this worker so compatibility costs only one extra attempt.
      tightCopyRejected = true
    }
  }

  const bytes = frame.allocationSize(nativeLumaOptions)
  const ptr = ensureInput(zx, bytes)
  const layouts = await frame.copyTo(inputView, nativeLumaOptions)
  if (tightCopyRejected) tightLayoutRejected.add(format)
  const y = layouts[0]
  if (!y || y.offset < 0 || y.stride < w || y.offset + (h - 1) * y.stride + w > bytes) {
    throw new Error("VideoFrame returned an invalid luminance-plane layout")
  }

  // With no requested layout, implementations may pad Y rows. Compact them
  // in place so the optical codec receives exactly width*height packed bytes.
  // Copying top-to-bottom is safe because every destination row begins at or
  // before its source row.
  if (y.offset !== 0 || y.stride !== w) {
    for (let row = 0; row < h; row++) {
      const src = ptr + y.offset + row * y.stride
      zx.HEAPU8.copyWithin(ptr + row * w, src, src + w)
    }
  }
  return {
    ptr,
    w,
    h,
    kind: "lum",
  }
}

async function videoFramePackedIntoWasm(
  zx: OpticalModule,
  frame: VideoFrame,
  format: PackedVideoFormat,
  w: number,
  h: number,
  sx: number,
  sy: number,
): Promise<WasmPixels> {
  const bytes = w * h * 4
  const ptr = ensureInput(zx, bytes)
  setCopyRect(sx, sy, w, h)
  packedOptions.format = format
  packedLayout[0].stride = w * 4
  await frame.copyTo(inputView, packedOptions)
  return {
    ptr,
    w,
    h,
    kind: format === "BGRA" || format === "BGRX" ? "bgrx" : "rgba",
  }
}

/** Copy a capture into the stable WASM allocation. VideoFrame is the preferred
 *  path: planar camera formats expose Y directly, while packed RGB formats
 *  retain their native channel order. Unknown formats request compatibility
 *  RGBA. The readback fallback supplies an already-materialized RGBA buffer. */
async function pixelsIntoWasm(
  zx: OpticalModule,
  buf: ArrayBuffer | undefined,
  frame: VideoFrame | undefined,
  w: number,
  h: number,
  sx: number,
  sy: number,
): Promise<WasmPixels> {
  if (frame) {
    try {
      if (isLumaVideoFormat(frame.format)) {
        return await videoFrameLumaIntoWasm(zx, frame, frame.format, w, h, sx, sy)
      }

      switch (frame.format) {
        case "RGBA":
        case "RGBX":
        case "BGRA":
        case "BGRX":
          return await videoFramePackedIntoWasm(zx, frame, frame.format, w, h, sx, sy)
        default:
          return await videoFramePackedIntoWasm(zx, frame, "RGBA", w, h, sx, sy)
      }
    } catch (error) {
      throw new CaptureReadError(errorMessage(error))
    } finally {
      frame.close()
    }
  }

  const data = new Uint8Array(buf!)
  const ptr = ensureInput(zx, data.byteLength)
  zx.HEAPU8.set(data, ptr)
  return {
    ptr,
    w,
    h,
    kind: "rgba",
  }
}

/** Inflate one sender-produced PNG frame directly into the stable packed
 * monochrome WASM allocation. DecompressionStream may split anywhere, so the
 * row/filter state crosses output chunks without staging a complete scanline
 * or byte-per-pixel luminance image in JS memory. */
async function apngFrameIntoWasm(
  zx: OpticalModule,
  compressed: Blob | Uint8Array<ArrayBuffer>,
  w: number,
  h: number,
  metadata: OpticalApngMetadata,
): Promise<WasmPixels> {
  const { outputWidth, outputHeight, packedLength, columns, rows } = apngFrameGeometry(w, h, metadata)
  const ptr = ensureInput(zx, packedLength)
  await inflateApngFrameInto(compressed, w, h, inputView.subarray(0, packedLength), metadata)
  return {
    ptr,
    w: outputWidth,
    h: outputHeight,
    kind: "module-grid-mono1",
    moduleGrid: { qrVersion: metadata.qr, columns, rows },
  }
}

interface CodecReaders {
  full: OpticalModule["readFull"]
  fullLum: OpticalModule["readFullLum"]
  moduleGridMono1: OpticalModule["readModuleGridMono1"]
  fullBGRX: OpticalModule["readFullBGRX"]
}

let codecReaders: CodecReaders | undefined

function readersOf(zx: OpticalModule): CodecReaders {
  return (codecReaders ??= {
    full: zx.readFull.bind(zx),
    fullLum: zx.readFullLum.bind(zx),
    moduleGridMono1: zx.readModuleGridMono1.bind(zx),
    fullBGRX: zx.readFullBGRX.bind(zx),
  })
}

ctx.onmessage = (event: MessageEvent) => {
  if (isInitMessage(event.data)) {
    fountainPort = event.data.fountainPort
    resolveInit(event.data)
    return
  }
  void handleMessage(event)
}

function forwardPayloads(payloads: readonly Uint8Array[]): number {
  const buffers = payloads.filter((bytes) => bytes.length > 0).map(transferableBuffer)
  if (buffers.length === 0) return 0
  if (!fountainPort) throw new Error("The Fountain Worker channel is not initialized.")
  const message: FountainFramesMessage = { type: "frames", buffers }
  fountainPort.postMessage(message, buffers)
  return buffers.length
}

async function handleMessage(e: MessageEvent): Promise<void> {
  const message = e.data as {
    type?: "apng-frame"
    id: number
    /** Readback-fallback capture: raw RGBA. */
    buf?: ArrayBuffer
    /** Preferred capture: camera resource transferred without a pixel copy. */
    frame?: VideoFrame
    w?: number
    h?: number
    /** Crop origin in the VideoFrame's coded/visible pixel coordinates. */
    sx?: number
    sy?: number
    /** APNG capture: one independently compressed full-frame zlib stream. */
    compressed?: Blob | Uint8Array<ArrayBuffer>
    metadata?: OpticalApngMetadata
    index?: number
    total?: number
  }
  const { id, buf, frame, w = 0, h = 0, sx = 0, sy = 0 } = message
  const apng =
    message.type === "apng-frame" && message.index !== undefined && message.total !== undefined
      ? { index: message.index, total: message.total }
      : undefined
  let forwardedSymbols = 0
  try {
    const zx = await ready
    const readers = readersOf(zx)
    let pixels: WasmPixels
    if (message.compressed) {
      const metadata = message.metadata
      if (!metadata) throw new Error("The APNG QR metadata is missing.")
      pixels = await apngFrameIntoWasm(zx, message.compressed, w, h, metadata)
    } else {
      pixels = await pixelsIntoWasm(zx, buf, frame, w, h, sx, sy)
    }
    const { ptr, w: pw, h: ph, kind } = pixels

    if (kind === "module-grid-mono1") {
      const grid = pixels.moduleGrid
      if (!grid) throw new Error("The APNG QR grid metadata is missing.")
      const payloads = readers.moduleGridMono1(ptr, pw, ph, grid.qrVersion, grid.columns, grid.rows)
      forwardedSymbols += forwardPayloads(payloads)
    } else {
      const readFull = kind === "lum" ? readers.fullLum : kind === "bgrx" ? readers.fullBGRX : readers.full
      const payloads = readFull(ptr, pw, ph, 9)
      forwardedSymbols += forwardPayloads(payloads)
    }
    ctx.postMessage({
      id,
      forwardedSymbols,
      apng,
    })
  } catch (error) {
    // A VideoFrame copy failure usually means this browser exposes the API but
    // cannot copy camera frames even in their native layout. Tell the UI to
    // switch to its proven Canvas path after a few such failures.
    frame?.close()
    ctx.postMessage({
      id,
      forwardedSymbols,
      apng,
      ...(apng ? { error: errorMessage(error) } : { captureError: error instanceof CaptureReadError }),
    })
  }
}

// Confirm WASM initialization before treating this worker as healthy, then
// warm its first-call JIT. Warm-up itself is optional; initialization is not.
void (async () => {
  const warmSize = 29 // QR version 1 plus a four-module quiet zone on every side.
  let ptr = 0
  let zx: OpticalModule | undefined
  try {
    zx = await ready
  } catch (error) {
    ctx.postMessage({
      id: -1,
      forwardedSymbols: 0,
      error: `QR decoder initialization failed: ${errorMessage(error)}`,
    })
    return
  }
  try {
    ptr = zx._malloc(warmSize * warmSize * 4)
    if (!ptr) throw new Error("The QR decoder warm-up allocation failed.")
    zx.HEAPU8.fill(255, ptr, ptr + warmSize * warmSize * 4)
    zx.readFull(ptr, warmSize, warmSize, 1)
    zx.readFullBGRX(ptr, warmSize, warmSize, 1)
    zx.readFullLum(ptr, warmSize, warmSize, 1)
    zx.readModuleGridMono1(ptr, warmSize, warmSize, 1, 1, 1)
  } catch {
    // a failed warm-up is a slow first frame, not an error
  } finally {
    if (ptr) zx?._free(ptr)
  }
  ctx.postMessage({
    id: -1,
    forwardedSymbols: 0,
  })
})()
