import { defaultQrScale, exportSymbolCount } from "../shared/fountain.js"
import { gridDims, qrVersion, TRANSFER_QR_MARGIN } from "../shared/qr.js"
import { OPTICAL_APNG_FORMAT_VERSION } from "../shared/apng-format.js"
import { copyQrMonochrome, createMonochromeFrame } from "../shared/monochrome.js"
import { OpticalQrFrameEncoder } from "../shared/qr-frame-encoder.js"
import type { PackedOpticalFile } from "../shared/protocol.js"
import { MAX_RAPTORQ_SOURCE_SYMBOLS } from "../shared/wire.js"
import type { ApngExportOptions, ApngExportResult } from "../shared/worker-messages.js"
import { ApngEncoder } from "./apng.js"

export type ApngProgress = (completed: number, total: number) => void

function outputName(name: string, partIndex?: number): string {
  const safe = name.replace(/[\\/:*?"<>|]/g, "_").trim() || "qr-transfer"
  if (partIndex === undefined) return `${safe}.qr.png`
  return `${safe}.qr.${String(partIndex + 1).padStart(3, "0")}.png`
}

function cancelled(): Error {
  const error = new Error("APNG export cancelled.")
  error.name = "AbortError"
  return error
}

/** Encode an already prepared transfer. The caller owns preparation and keeps
 * the packed parts alive until this promise settles; this function always
 * releases its QR encoder in the finally block. */
export async function exportPreparedApng(
  parts: readonly (PackedOpticalFile | undefined)[],
  fileName: string,
  options: ApngExportOptions,
  onProgress: ApngProgress,
  isCancelled: () => boolean = () => false,
): Promise<ApngExportResult> {
  let encoder: OpticalQrFrameEncoder | undefined
  try {
    const partIndex = options.partIndex ?? 0
    const packed = parts[partIndex]
    if (!packed) throw new RangeError("The requested optical part does not exist.")
    encoder = new OpticalQrFrameEncoder({
      container: packed.container,
      containerTag: packed.containerTag,
      part: packed.part,
      frameBytes: options.frameBytes,
      ecc: options.ecc,
    })
    if (encoder.k > MAX_RAPTORQ_SOURCE_SYMBOLS) {
      throw new Error("The current bytes-per-frame setting cannot fit this file in one QR stream.")
    }
    const symbols = exportSymbolCount(encoder.k, options.extraPercent)
    const frames = Math.ceil(symbols / options.gridCodes)
    const { cols, rows } = gridDims(options.gridCodes)
    const qrScale = Math.min(4, Math.max(1, options.qrScale ?? defaultQrScale(options.gridCodes)))
    const firstQr = encoder.encode(0)
    const cell = firstQr.size + 2 * TRANSFER_QR_MARGIN
    const width = cell * qrScale * cols
    const height = cell * qrScale * rows
    const apng = new ApngEncoder(width, height, frames, options.txFps, {
      format: OPTICAL_APNG_FORMAT_VERSION,
      scale: qrScale,
      grid: options.gridCodes,
      qr: qrVersion(firstQr),
    })
    const monochrome = createMonochromeFrame(width, height)
    let lastProgressAt = 0

    for (let frame = 0; frame < frames; frame++) {
      if (isCancelled()) throw cancelled()
      for (let cellIndex = 0; cellIndex < options.gridCodes; cellIndex++) {
        const sequence = (frame * options.gridCodes + cellIndex) % symbols
        const qr = sequence === 0 ? firstQr : encoder.encode(sequence)
        copyQrMonochrome(
          monochrome,
          apng.width,
          apng.height,
          qr,
          TRANSFER_QR_MARGIN,
          (cellIndex % cols) * cell * qrScale,
          Math.floor(cellIndex / cols) * cell * qrScale,
          qrScale,
        )
      }
      await apng.addFrame(monochrome)
      const now = performance.now()
      if (frame + 1 === frames || now - lastProgressAt >= 150) {
        lastProgressAt = now
        onProgress(frame + 1, frames)
      }
    }

    return {
      blob: apng.finish(),
      filename: outputName(fileName, options.partIndex),
      frames,
      symbols,
      width: apng.width,
      height: apng.height,
    }
  } finally {
    encoder?.free()
  }
}
