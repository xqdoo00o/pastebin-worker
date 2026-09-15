import type { QrErrorCorrection } from "./qr.js"
import type { PackedOpticalFile } from "./protocol.js"
import type { OpticalApngMetadata } from "./apng-format.js"

export interface PreparedOpticalFile {
  /** Largest single container, used for the fits-in-one-stream check. */
  containerSize: number
  compression: "none" | "zstd"
  /** Whole-file (pre-split) size. */
  originalSize: number
  /** Sum of every part's transmitted size. */
  transmittedSize: number
  /** Total parts; 1 means a standalone single-part transfer. */
  partCount: number
}

/** Settings for an APNG carousel once the sender has prepared its parts. */
export interface ApngExportOptions {
  frameBytes: number
  ecc: QrErrorCorrection
  gridCodes: number
  txFps: number
  /** Pool size beyond K, as a percentage from 1 to 100. */
  extraPercent: number
  /** QR module pixel scale for the exported APNG. */
  qrScale?: number
  /** Zero-based part to export; absent means the standalone part. */
  partIndex?: number
}

export interface ApngExportResult {
  blob: Blob
  filename: string
  frames: number
  symbols: number
  width: number
  height: number
}

export type SenderWorkerInput =
  | {
      type: "init"
      wasmModule: WebAssembly.Module
      xxhashWasmModule: WebAssembly.Module
      zstdEncoderWasmModule?: WebAssembly.Module
    }
  | { type: "prepare"; file: File; mediaType?: string }
  | { type: "prepareBytes"; name: string; mediaType: string; data: ArrayBuffer }
  | {
      type: "configure"
      session: number
      frameBytes: number
      ecc: QrErrorCorrection
    }
  | { type: "generate"; session: number; count: number; recycledBuffers: ArrayBuffer[] }
  | { type: "switchPart"; session: number; part: number }
  | { type: "copyPreparedPart"; requestId: number; part: number }
  | { type: "dispose" }

export type SenderWorkerOutput =
  | { type: "prepared"; file: PreparedOpticalFile }
  | {
      type: "batch"
      session: number
      monochromeBuffers: ArrayBuffer[]
      version: number
      modules: number
      /** Which part produced this batch; the UI drops batches from a stale part. */
      part: number
    }
  | { type: "preparedPart"; requestId: number; part: PackedOpticalFile }
  | { type: "disposed" }
  | { type: "error"; message: string; session?: number }

/** One short-lived worker owns one export, keeping APNG encoding independent
 * from the long-lived worker that generates the live QR camera stream. */
export type ApngWorkerInput = {
  type: "export"
  wasmModule: WebAssembly.Module
  fileName: string
  /** A copied selected part; its ArrayBuffer is transferred through the page. */
  part: PackedOpticalFile
} & ApngExportOptions

export type ApngWorkerOutput =
  | { type: "progress"; completed: number; total: number }
  | ({ type: "done" } & ApngExportResult)
  | { type: "error"; message: string }

export type ApngParserWorkerInput =
  | { type: "start"; file: File; credits: number }
  | { type: "startBytes"; data: ArrayBuffer; credits: number }
  | { type: "credit" }

export type ApngParserWorkerOutput =
  | {
      type: "frame"
      compressed: Blob | Uint8Array<ArrayBuffer>
      width: number
      height: number
      metadata: OpticalApngMetadata
      index: number
      total: number
    }
  | { type: "done"; width: number; height: number; frames: number; metadata: OpticalApngMetadata }
  | { type: "error"; message: string }

export interface DecodeWorkerOutput {
  id: number
  /** QR payloads transferred directly to the Fountain Worker for this capture. */
  forwardedSymbols: number
  /** The browser could not materialize a transferred VideoFrame. */
  captureError?: boolean
  /** Present only for a frame extracted from an APNG file. */
  apng?: { index: number; total: number }
  /** APNG frame failures are actionable file errors, unlike disposable camera frames. */
  error?: string
}
