// RFC 6330 RaptorQ adapter for the one-way optical stream. The WASM codec
// emits repair-only symbols: every live frame is fresh, any K plus a tiny
// rank margin can reconstruct the object, and no sender/receiver handshake is
// required. The wire packet itself carries the standard SBN + ESI Payload ID.

import { RAPTORQ_PAYLOAD_ID_BYTES, type FramePart } from "./wire.js"
import { WasmNanoRQDecoder, WasmNanoRQEncoder } from "./nanorq-runtime.js"
import { raptorQPacketEncodingSymbolId } from "./wire.js"

/** Immutable progress state sent from the fountain worker to the UI. */
export interface FountainSnapshot {
  identity: string
  k: number
  symbolLen: number
  framesNew: number
}

export interface FountainFramesMessage {
  type: "frames"
  /** Complete optical wire frames from one capture. Ownership transfers to the worker. */
  buffers: ArrayBuffer[]
}

export interface FountainInitMessage {
  type: "init"
  wasmModule: WebAssembly.Module
  xxhashWasmModule: WebAssembly.Module
}

export interface FountainConnectMessage {
  type: "connect"
  connectionId: number
  port: MessagePort
}

export interface FountainDisconnectMessage {
  type: "disconnect"
  connectionId: number
}

export interface ExpectedOpticalTransfer {
  transferId: bigint
  count: number
  /** Zero-based indexes that are still acceptable. */
  missing: number[]
}

export function expectedTransferVerdict(part: FramePart, expected: ExpectedOpticalTransfer | null): string | null {
  if (!expected) return null
  if (part.count === 0 || part.transferId === undefined) {
    return "This standalone optical file does not belong to the multipart transfer in progress."
  }
  if (part.transferId !== expected.transferId || part.count !== expected.count) {
    return "This optical part belongs to a different transfer."
  }
  if (!expected.missing.includes(part.index)) return `Optical part ${part.index + 1} has already been received.`
  return null
}

export interface FountainExpectTransferMessage {
  type: "expectTransfer"
  expected: ExpectedOpticalTransfer | null
}

export type FountainWorkerInput =
  | FountainInitMessage
  | FountainConnectMessage
  | FountainDisconnectMessage
  | FountainExpectTransferMessage

export interface FountainProgressMessage {
  type: "progress"
  /** True for the first valid frame of a new stream identity. */
  started: boolean
  snapshot: FountainSnapshot
}

export interface FountainCompleteMessage {
  type: "complete"
  snapshot: FountainSnapshot
  part: FramePart
  /** Reassembled optical container. Ownership transfers back to the UI. */
  container: ArrayBuffer
}

export interface FountainErrorMessage {
  type: "error"
  message: string
}

export interface FountainReadyMessage {
  type: "ready"
}

export interface FountainVerdictMessage {
  type: "verdict"
  /** Null clears a previously reported compatibility error. */
  message: string | null
  /** Transfer routing mismatches are recoverable without clearing multipart state. */
  reason?: "transfer"
}

/** Acknowledges that one submitted QR payload finished fountain decoding. */
export interface FountainProcessedMessage {
  type: "processed"
  count: number
}

export type FountainWorkerOutput =
  | FountainReadyMessage
  | FountainProgressMessage
  | FountainCompleteMessage
  | FountainErrorMessage
  | FountainVerdictMessage
  | FountainProcessedMessage

/** Default extra-symbol percentage for APNG exports. Keeps the exported pool
 * close to K while still giving the fountain matrix a rank margin. */
export const DEFAULT_EXPORT_EXTRA_PERCENT = 2

/** A finite APNG loops, so a small pool beyond K gives the matrix a rank
 * margin while keeping export size close to the original object size.
 * `extraPercent` is the pool size beyond K, from 1 to 100; 100 doubles the
 * volume by exporting K extra symbols. */
export function exportSymbolCount(sourceSymbols: number, extraPercent: number): number {
  const extra = Math.max(8, Math.ceil(sourceSymbols * (extraPercent / 100)))
  return sourceSymbols + extra
}

/** Four physical pixels per QR module keeps exported animations camera-friendly. */
export const APNG_QR_SCALE = 4

/** Selectable QR module pixel scales offered by the APNG export UI (1x to 4x). */
export const APNG_QR_SCALE_OPTIONS = [1, 2, 3, 4] as const
export type ApngQrScale = (typeof APNG_QR_SCALE_OPTIONS)[number]

/**
 * Default QR module pixel scale for an APNG export, reduced for dense grids so
 * the canvas does not grow too large. Used as the UI's initial selection and
 * as the worker's fallback when no scale is provided.
 */
export function defaultQrScale(gridCodes: number): number {
  return APNG_QR_SCALE - (gridCodes > 4 ? 2 : gridCodes > 1 ? 1 : 0)
}

export class RaptorQEncoder {
  readonly k: number
  readonly packetLen: number
  private readonly encoder: WasmNanoRQEncoder

  constructor(payload: Uint8Array, symbolLen: number) {
    this.encoder = new WasmNanoRQEncoder(payload, symbolLen)
    this.k = this.encoder.sourceSymbols
    this.packetLen = this.encoder.packetLength
  }

  encode(sequence: number): Uint8Array {
    return this.encoder.encodeRepair(sequence)
  }

  encodeInto(sequence: number, output: Uint8Array): Uint8Array {
    return this.encoder.encodeRepairInto(sequence, output)
  }

  free(): void {
    this.encoder.free()
  }
}

export class RaptorQDecoder {
  private readonly decoder: WasmNanoRQDecoder
  private readonly seen = new Set<number>()
  private result: Uint8Array | undefined
  framesNew = 0
  readonly k: number
  readonly symbolLen: number

  constructor(packetLen: number, totalLen: number) {
    this.symbolLen = packetLen - RAPTORQ_PAYLOAD_ID_BYTES
    this.k = Math.ceil(totalLen / this.symbolLen)
    this.decoder = new WasmNanoRQDecoder(totalLen, this.symbolLen)
  }

  get isComplete(): boolean {
    return this.result !== undefined
  }

  addFrame(block: Uint8Array): void {
    const encodingSymbolId = raptorQPacketEncodingSymbolId(block)
    if (this.seen.has(encodingSymbolId)) return
    this.seen.add(encodingSymbolId)
    this.framesNew++
    if (this.result) return
    this.result = this.decoder.add(block)
  }

  assemble(): Uint8Array | null {
    return this.result ?? null
  }

  free(): void {
    this.decoder.free()
  }
}
