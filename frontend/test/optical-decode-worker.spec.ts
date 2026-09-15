import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

import { referenceTransferQr } from "./qr-reference.js"
import { TRANSFER_QR_MARGIN } from "../optical/shared/qr.js"
import { tightVideoFrameLayout } from "../optical/shared/capture.js"
import type { DecodeWorkerOutput } from "../optical/shared/worker-messages.js"

interface Plane {
  offset: number
  stride: number
}

/** Minimal I420 VideoFrame. `offsetBase` selects the two `PlaneLayout.offset`
 * conventions seen in the wild: absolute offsets from the destination view, or
 * per-plane offsets that every plane reports as zero. */
function makeI420Frame(
  width: number,
  height: number,
  offsetBase: "destination" | "plane",
  paint: (planeIndex: number, x: number, y: number) => number,
) {
  return {
    format: "I420",
    allocationSize() {
      return tightVideoFrameLayout("I420", width, height).byteLength
    },
    copyTo(destination: Uint8Array, options: { layout?: Plane[] }) {
      const layout = options.layout?.length ? options.layout : tightVideoFrameLayout("I420", width, height).layout
      const halfWidth = Math.ceil(width / 2)
      const halfHeight = Math.ceil(height / 2)
      const planes: [number, number][] = [
        [width, height],
        [halfWidth, halfHeight],
        [halfWidth, halfHeight],
      ]
      planes.forEach(([planeWidth, planeHeight], plane) => {
        const { offset, stride } = layout[plane]
        for (let y = 0; y < planeHeight; y++) {
          for (let x = 0; x < planeWidth; x++) {
            destination[offset + y * stride + x] = paint(plane, x, y)
          }
        }
      })
      return Promise.resolve(
        layout.map((entry) => ({ offset: offsetBase === "destination" ? entry.offset : 0, stride: entry.stride })),
      )
    },
    close() {
      // The mock owns no operating-system resources to release.
    },
  }
}

async function decodeLiveFrame(offsetBase: "destination" | "plane") {
  const codecWasm = await WebAssembly.compile(readFileSync("frontend/optical/codec/optical_codec_simd.wasm"))
  const payload = Uint8Array.from({ length: 120 }, (_, index) => (index * 37 + 11) & 0xff)
  const qr = referenceTransferQr(payload, "L")
  const scale = 6
  const width = (qr.size + 2 * TRANSFER_QR_MARGIN) * scale
  const moduleDark = (bitmap: typeof qr, pixelX: number, pixelY: number) => {
    const moduleX = Math.floor(pixelX / scale) - TRANSFER_QR_MARGIN
    const moduleY = Math.floor(pixelY / scale) - TRANSFER_QR_MARGIN
    return (
      moduleX >= 0 && moduleY >= 0 && moduleX < bitmap.size && moduleY < bitmap.size && bitmap.get(moduleX, moduleY)
    )
  }
  const frame = makeI420Frame(width, width, offsetBase, (plane, x, y) => {
    if (plane === 0) return moduleDark(qr, x, y) ? 16 : 235
    return 128
  })

  const outputs: DecodeWorkerOutput[] = []
  const channel = new MessageChannel()
  vi.stubGlobal("self", {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: (message: DecodeWorkerOutput) => {
      outputs.push(message)
    },
  })
  vi.resetModules()
  await import("../optical/receive/worker.js")
  const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null }
  scope.onmessage!({
    data: { type: "init", wasmModule: codecWasm, fountainPort: channel.port2 },
  } as MessageEvent)
  scope.onmessage!({ data: { id: 1, frame, w: width, h: width, sx: 0, sy: 0 } } as MessageEvent)

  await vi.waitFor(() => expect(outputs.some((output) => output.id === 1)).toBe(true))
  const result = outputs.find((output) => output.id === 1)!
  vi.unstubAllGlobals()
  return result
}

describe("optical decode worker luminance capture", () => {
  it("recovers the payload from a live I420 VideoFrame", async () => {
    const result = await decodeLiveFrame("destination")
    expect(result).toMatchObject({ forwardedSymbols: 1 })
  }, 30000)

  it("samples the luminance plane when copyTo reports per-plane offsets", async () => {
    const result = await decodeLiveFrame("plane")
    expect(result).toMatchObject({ forwardedSymbols: 1 })
  }, 30000)
})
