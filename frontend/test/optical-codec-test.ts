import { readFile } from "node:fs/promises"
import OpticalCodec, { type OpticalModule } from "../optical/codec/optical_codec.js"
import { qrMonochrome } from "../optical/shared/monochrome.js"
import { TRANSFER_QR_MARGIN } from "../optical/shared/qr.js"

import type { ReferenceQrBitmap } from "./qr-reference.js"

const codecs = new Map<"simd" | "scalar", Promise<OpticalModule>>()

/** Decoder calls are synchronous; each test file can reuse one instance per variant. */
export function loadOpticalTestCodec(variant: "simd" | "scalar"): Promise<OpticalModule> {
  let codec = codecs.get(variant)
  if (!codec) {
    codec = readFile(`frontend/optical/codec/optical_codec_${variant}.wasm`)
      .then((bytes) => WebAssembly.compile(bytes))
      .then((wasm) =>
        OpticalCodec({
          instantiateWasm(imports, done) {
            const instance = new WebAssembly.Instance(wasm, imports)
            done(instance, wasm)
            return instance.exports
          },
        }),
      )
    codecs.set(variant, codec)
  }
  return codec
}

export function withOpticalInput<T>(codec: OpticalModule, bytes: Uint8Array, read: (ptr: number) => T): T {
  const ptr = codec._malloc(bytes.length)
  try {
    codec.HEAPU8.set(bytes, ptr)
    return read(ptr)
  } finally {
    codec._free(ptr)
  }
}

/** Exercise exact APNG module sampling and camera detection on the same symbol. */
export function decodeTransferQr(codec: OpticalModule, qr: ReferenceQrBitmap): number[][][] {
  const frame = qrMonochrome(qr, TRANSFER_QR_MARGIN)
  const grid = withOpticalInput(codec, frame.data, (ptr) =>
    codec.readModuleGridMono1(ptr, frame.width, frame.height, (qr.size - 17) / 4, 1, 1),
  )
  const scale = 4
  const width = frame.width * scale
  const luminance = new Uint8Array(width * width).fill(255)
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.get(x, y)) continue
      const left = (x + TRANSFER_QR_MARGIN) * scale
      const top = (y + TRANSFER_QR_MARGIN) * scale
      for (let row = top; row < top + scale; row++) luminance.fill(0, row * width + left, row * width + left + scale)
    }
  }
  const camera = withOpticalInput(codec, luminance, (ptr) => codec.readFullLum(ptr, width, width, 1))
  return [grid, camera].map((symbols) => symbols.map((bytes) => Array.from(bytes)))
}
