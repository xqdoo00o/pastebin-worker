import { benchmarkBytes, median } from "../benchmark-utils.mjs"
import { readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"

import { correction, generate, mode } from "lean-qr"

const projectDir = import.meta.dirname
const options = parseOptions(process.argv.slice(2))
const QR_VERSION = 40
const QR_SCALE = 4
const QR_MARGIN = 4
// Deliberately not divisible by 4, 8 or 16 so every SIMD tail is exercised.
const IMAGE_SIZE = 803
const PAYLOAD_SIZE = 512

function parseOptions(args) {
  const result = { candidate: join(projectDir, "dist"), baseline: undefined, samples: 9, variant: "simd" }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    if (flag === "--candidate") result.candidate = resolve(projectDir, value)
    else if (flag === "--baseline") result.baseline = resolve(projectDir, value)
    else if (flag === "--samples") result.samples = Number.parseInt(value, 10)
    else if (flag === "--variant") result.variant = value
    else throw new Error(`Unknown argument: ${flag}`)
  }
  if (!Number.isSafeInteger(result.samples) || result.samples < 3) throw new Error("--samples must be at least 3")
  if (result.variant !== "simd" && result.variant !== "scalar") throw new Error("--variant must be simd or scalar")
  return result
}

function drawQr(lum, width, qr, scale, left, top) {
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      const value = qr.get(x, y) ? 18 : 244
      const pixelX = left + x * scale
      const pixelY = top + y * scale
      for (let yy = 0; yy < scale; yy++) {
        lum.fill(value, (pixelY + yy) * width + pixelX, (pixelY + yy) * width + pixelX + scale)
      }
    }
  }
}

function makeFixture() {
  const payload = benchmarkBytes(PAYLOAD_SIZE)
  const qr = generate(mode.bytes(payload), {
    minCorrectionLevel: correction.M,
    maxCorrectionLevel: correction.M,
    minVersion: QR_VERSION,
    maxVersion: QR_VERSION,
    mask: 3,
  })
  const rasterSize = (qr.size + 2 * QR_MARGIN) * QR_SCALE
  const origin = Math.floor((IMAGE_SIZE - rasterSize) / 2)
  const codeOrigin = origin + QR_MARGIN * QR_SCALE
  const lum = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE)
  const rgba = new Uint8Array(lum.length * 4)
  const bgrx = new Uint8Array(lum.length * 4)
  const blank = new Uint8Array(lum.length)
  const blankPacked = new Uint8Array(lum.length * 4)
  lum.fill(244)
  blank.fill(244)
  blankPacked.fill(244)
  drawQr(lum, IMAGE_SIZE, qr, QR_SCALE, codeOrigin, codeOrigin)
  for (let index = 0; index < lum.length; index++) {
    const dark = lum[index] < 128
    const [red, green, blue] = dark ? [8, 20, 32] : [238, 247, 252]
    const offset = index * 4
    rgba[offset] = red
    rgba[offset + 1] = green
    rgba[offset + 2] = blue
    rgba[offset + 3] = 255
    bgrx[offset] = blue
    bgrx[offset + 1] = green
    bgrx[offset + 2] = red
    bgrx[offset + 3] = 255
  }
  const apngSize = qr.size + 2 * QR_MARGIN
  const apngStride = Math.ceil(apngSize / 8)
  const apngMono1 = new Uint8Array(apngStride * apngSize).fill(0xff)
  const blankApngMono1 = new Uint8Array(apngMono1.length).fill(0xff)
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.get(x, y)) continue
      const targetX = x + QR_MARGIN
      apngMono1[(y + QR_MARGIN) * apngStride + (targetX >> 3)] &= ~(0x80 >> (targetX & 7))
    }
  }

  // The camera path requests up to nine symbols. Keep that path measurable
  // separately from the historical single-symbol fixture and flat miss.
  const cameraPayloads = Array.from({ length: 9 }, (_, index) =>
    Uint8Array.from({ length: 80 }, (__, offset) => (offset * 31 + index * 17) & 0xff),
  )
  const cameraLum = new Uint8Array(lum.length).fill(244)
  const cameraVersion = 7
  // Keep the four histogram sample rows inside QR data rather than quiet zones.
  const cameraScale = 4
  const cameraQrSize = 17 + 4 * cameraVersion
  const cameraCell = (cameraQrSize + 2 * QR_MARGIN) * cameraScale
  const cameraOrigin = Math.floor((IMAGE_SIZE - cameraCell * 3) / 2)
  for (let index = 0; index < cameraPayloads.length; index++) {
    const code = generate(mode.bytes(cameraPayloads[index]), {
      minCorrectionLevel: correction.M,
      maxCorrectionLevel: correction.M,
      minVersion: cameraVersion,
      maxVersion: cameraVersion,
      mask: 3,
    })
    const left = cameraOrigin + (index % 3) * cameraCell + QR_MARGIN * cameraScale
    const top = cameraOrigin + Math.floor(index / 3) * cameraCell + QR_MARGIN * cameraScale
    drawQr(cameraLum, IMAGE_SIZE, code, cameraScale, left, top)
  }

  const texturedMiss = new Uint8Array(lum.length)
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      texturedMiss[y * IMAGE_SIZE + x] = ((x >> 2) ^ (y >> 2)) & 1 ? 18 : 244
    }
  }

  return {
    payload,
    lum,
    rgba,
    bgrx,
    blank,
    blankPacked,
    cameraLum,
    cameraPayloads,
    texturedMiss,
    apngMono1,
    blankApngMono1,
    apngSize,
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
  }
}

async function loadCodec(directory, variant) {
  const modulePath = join(directory, "optical_codec.js")
  const wasmPath = join(directory, `optical_codec_${variant}.wasm`)
  const { default: createCodec } = await import(`${pathToFileURL(modulePath).href}?benchmark=${Date.now()}`)
  const wasm = await readFile(wasmPath)
  const dataUrl = `data:application/wasm;base64,${wasm.toString("base64")}`
  return createCodec({ locateFile: () => dataUrl })
}

function equalBytes(actual, expected) {
  if (actual.length !== expected.length) return false
  for (let index = 0; index < expected.length; index++) if (actual[index] !== expected[index]) return false
  return true
}

/** Keep historical Embind-vector artifacts benchmarkable after the public
 * result changed to a plain Uint8Array[]. The candidate's Array.isArray check
 * deliberately remains in the timed region, making comparisons conservative. */
function takeSymbols(result) {
  if (Array.isArray(result)) return result

  const symbols = []
  try {
    for (let index = 0; index < result.size(); index++) symbols.push(result.get(index).bytes)
  } finally {
    result.delete()
  }
  return symbols
}

function prepare(codec, fixture) {
  const lumPtr = codec._malloc(fixture.lum.length)
  const rgbaPtr = codec._malloc(fixture.rgba.length)
  const bgrxPtr = codec._malloc(fixture.bgrx.length)
  const blankPtr = codec._malloc(fixture.blank.length)
  const blankPackedPtr = codec._malloc(fixture.blankPacked.length)
  const cameraPtr = codec._malloc(fixture.cameraLum.length)
  const texturedMissPtr = codec._malloc(fixture.texturedMiss.length)
  const apngMono1Ptr = codec._malloc(fixture.apngMono1.length)
  const blankApngMono1Ptr = codec._malloc(fixture.blankApngMono1.length)
  codec.HEAPU8.set(fixture.lum, lumPtr)
  codec.HEAPU8.set(fixture.rgba, rgbaPtr)
  codec.HEAPU8.set(fixture.bgrx, bgrxPtr)
  codec.HEAPU8.set(fixture.blank, blankPtr)
  codec.HEAPU8.set(fixture.blankPacked, blankPackedPtr)
  codec.HEAPU8.set(fixture.cameraLum, cameraPtr)
  codec.HEAPU8.set(fixture.texturedMiss, texturedMissPtr)
  codec.HEAPU8.set(fixture.apngMono1, apngMono1Ptr)
  codec.HEAPU8.set(fixture.blankApngMono1, blankApngMono1Ptr)
  const full = (kind) => {
    const symbols = takeSymbols(
      kind === "lum"
        ? codec.readFullLum(lumPtr, fixture.width, fixture.height, 1)
        : kind === "bgrx"
          ? codec.readFullBGRX(bgrxPtr, fixture.width, fixture.height, 1)
          : codec.readFull(rgbaPtr, fixture.width, fixture.height, 1),
    )
    const valid = symbols.length === 1 && equalBytes(symbols[0], fixture.payload)
    if (!valid) throw new Error(`readFull${kind === "lum" ? "Lum" : ""} failed the benchmark fixture`)
  }

  const fullMiss = () => {
    const symbols = takeSymbols(codec.readFullLum(blankPtr, fixture.width, fixture.height, 1))
    const valid = symbols.length === 0
    if (!valid) throw new Error("readFullLum unexpectedly decoded the blank fixture")
  }

  const cameraSingle = () => {
    const symbols = takeSymbols(codec.readFullLum(lumPtr, fixture.width, fixture.height, 9))
    if (symbols.length !== 1 || !equalBytes(symbols[0], fixture.payload)) {
      throw new Error("Nine-symbol camera search failed the single-symbol fixture")
    }
  }

  const cameraGrid = () => {
    const symbols = takeSymbols(codec.readFullLum(cameraPtr, fixture.width, fixture.height, 9))
    const matched = fixture.cameraPayloads.filter((expected) => symbols.some((actual) => equalBytes(actual, expected)))
    if (symbols.length !== fixture.cameraPayloads.length || matched.length !== fixture.cameraPayloads.length) {
      throw new Error(`Nine-symbol camera search found ${symbols.length} symbols, ${matched.length} expected`)
    }
  }

  const cameraTexturedMiss = () => {
    const symbols = takeSymbols(codec.readFullLum(texturedMissPtr, fixture.width, fixture.height, 9))
    if (symbols.length !== 0) throw new Error("Textured camera miss unexpectedly decoded a symbol")
  }

  const packedMiss = (kind) => {
    const symbols = takeSymbols(
      kind === "bgrx"
        ? codec.readFullBGRX(blankPackedPtr, fixture.width, fixture.height, 1)
        : codec.readFull(blankPackedPtr, fixture.width, fixture.height, 1),
    )
    const valid = symbols.length === 0
    if (!valid) throw new Error(`readFull${kind === "bgrx" ? "BGRX" : "RGBA"} unexpectedly decoded the blank fixture`)
  }

  const apngGridDirect =
    typeof codec.readModuleGridMono1 === "function"
      ? (blank = false) => {
          const ptr = blank ? blankApngMono1Ptr : apngMono1Ptr
          const symbols = takeSymbols(
            codec.readModuleGridMono1(ptr, fixture.apngSize, fixture.apngSize, QR_VERSION, 1, 1),
          )
          const valid = blank ? symbols.length === 0 : symbols.length === 1 && equalBytes(symbols[0], fixture.payload)
          if (!valid) throw new Error(`APNG direct-grid ${blank ? "miss" : "decode"} failed the benchmark fixture`)
        }
      : undefined

  return {
    cases: [
      { name: "readFullLum", iterations: 8, run: () => full("lum") },
      { name: "readFullLumCameraSingle", iterations: 8, run: cameraSingle },
      { name: "readFullLumCameraGrid", iterations: 4, run: cameraGrid },
      { name: "readFullLumCameraTexturedMiss", iterations: 8, run: cameraTexturedMiss },
      ...(apngGridDirect ? [{ name: "readModuleGridMono1", iterations: 20, run: () => apngGridDirect() }] : []),
      { name: "readFullRGBA", iterations: 8, run: () => full("rgba") },
      { name: "readFullBGRX", iterations: 8, run: () => full("bgrx") },
      { name: "readFullLumMiss", iterations: 12, run: fullMiss },
      ...(apngGridDirect ? [{ name: "readModuleGridMono1Miss", iterations: 30, run: () => apngGridDirect(true) }] : []),
      { name: "readFullRGBAMiss", iterations: 12, run: () => packedMiss("rgba") },
      { name: "readFullBGRXMiss", iterations: 12, run: () => packedMiss("bgrx") },
    ],
    dispose() {
      codec._free(texturedMissPtr)
      codec._free(cameraPtr)
      codec._free(blankApngMono1Ptr)
      codec._free(apngMono1Ptr)
      codec._free(blankPtr)
      codec._free(blankPackedPtr)
      codec._free(bgrxPtr)
      codec._free(rgbaPtr)
      codec._free(lumPtr)
    },
  }
}

function measure(test) {
  globalThis.gc?.()
  const started = performance.now()
  for (let iteration = 0; iteration < test.iterations; iteration++) test.run()
  return (performance.now() - started) / test.iterations
}

function warm(test) {
  for (let iteration = 0; iteration < Math.min(test.iterations, 20); iteration++) test.run()
}

const fixture = makeFixture()
const candidate = prepare(await loadCodec(options.candidate, options.variant), fixture)
const baseline = options.baseline ? prepare(await loadCodec(options.baseline, options.variant), fixture) : undefined
const baselineCases = new Map(baseline?.cases.map((test) => [test.name, test]))

try {
  for (const candidateCase of candidate.cases) {
    const baselineCase = baselineCases.get(candidateCase.name)
    warm(candidateCase)
    if (baselineCase) warm(baselineCase)
    const candidateTimes = []
    const baselineTimes = []
    for (let sample = 0; sample < options.samples; sample++) {
      const order = sample % 2 === 0 ? [baselineCase, candidateCase] : [candidateCase, baselineCase]
      for (const test of order) {
        if (!test) continue
        const elapsed = measure(test)
        ;(test === candidateCase ? candidateTimes : baselineTimes).push(elapsed)
      }
    }
    const candidateMs = median(candidateTimes)
    const result = { case: candidateCase.name, candidateMs }
    if (baselineCase) {
      const baselineMs = median(baselineTimes)
      result.baselineMs = baselineMs
      result.changePercent = (candidateMs / baselineMs - 1) * 100
      result.speedup = baselineMs / candidateMs
    }
    console.log(JSON.stringify(result))
  }
} finally {
  baseline?.dispose()
  candidate.dispose()
}
