import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { userEvent } from "@testing-library/user-event"
import { OpticalTransferPanel } from "../components/OpticalTransferPanel.js"
import type {
  PreparedOpticalFile,
  ApngExportResult,
  ApngWorkerInput,
  ApngWorkerOutput,
  SenderWorkerInput,
  SenderWorkerOutput,
} from "../optical/shared/worker-messages.js"
import type { PackedOpticalFile } from "../optical/shared/protocol.js"
import type { OpticalTransferSettings } from "../optical/shared/settings.js"
import { APNG_QR_SCALE, DEFAULT_EXPORT_EXTRA_PERCENT } from "../optical/shared/fountain.js"

import "@testing-library/jest-dom/vitest"

const wasmMocks = vi.hoisted(() => {
  const zstdModule = {}
  const xxhashModule = {}
  return {
    configuredWasmVariant: "auto",
    nanoRQModule: {},
    zstdModule,
    xxhashModule,
    loadZstdEncoderWasmModule: vi.fn(() => Promise.resolve(zstdModule)),
  }
})
const { nanoRQModule, zstdModule, xxhashModule, loadZstdEncoderWasmModule } = wasmMocks

vi.mock("../optical/shared/wasm-module.js", () => ({
  get configuredWasmVariant() {
    return wasmMocks.configuredWasmVariant
  },
  loadNanoRQCodecModule: () => Promise.resolve(nanoRQModule),
}))
vi.mock("../wasm/zstd-loader.js", () => ({
  loadZstdEncoderWasmModule: wasmMocks.loadZstdEncoderWasmModule,
  loadZstdDecoderWasmModule: () => Promise.resolve(zstdModule),
  ensureZstdEncoderReady: () => Promise.resolve(),
  ensureZstdDecoderReady: () => Promise.resolve(),
}))
vi.mock("../wasm/zstd-runtime.js", () => ({
  initializeZstdEncoder: () => Promise.resolve(),
  initializeZstdDecoder: () => Promise.resolve(),
  decompressZstd: () => Promise.resolve(new Uint8Array(0)),
}))
vi.mock("../wasm/xxhash-loader.js", () => ({
  loadXXHashWasmModule: () => Promise.resolve(xxhashModule),
  ensureXXHashReady: () => Promise.resolve(),
}))

class MockSenderWorker {
  static instances: MockSenderWorker[] = []

  onmessage: ((event: MessageEvent<SenderWorkerOutput | ApngWorkerOutput>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly messages: (SenderWorkerInput | ApngWorkerInput)[] = []
  readonly terminate = vi.fn()

  constructor() {
    MockSenderWorker.instances.push(this)
  }

  postMessage(message: SenderWorkerInput | ApngWorkerInput): void {
    this.messages.push(message)
  }

  emit(message: SenderWorkerOutput | ApngWorkerOutput): void {
    this.onmessage?.({ data: message } as MessageEvent<SenderWorkerOutput | ApngWorkerOutput>)
  }
}

function latestPartition(sender: MockSenderWorker) {
  const requests = sender.messages.filter(
    (message): message is Extract<SenderWorkerInput, { type: "partition" }> => message.type === "partition",
  )
  const request = requests[requests.length - 1]
  if (!request) throw new Error("Sender did not request a partition")
  return request
}

function prepareSender(sender: MockSenderWorker, file: PreparedOpticalFile) {
  if (!sender.messages.some((message) => message.type === "partition")) {
    act(() => sender.emit({ type: "payloadReady" }))
  }
  const { requestId, partPayloadSize } = latestPartition(sender)
  const message = { type: "prepared" as const, requestId, partPayloadSize, file }
  act(() => sender.emit(message))
  return message
}

let lastPaintedImage: ImageData | undefined

const canvasContext = {
  fillStyle: "",
  imageSmoothingEnabled: false,
  createImageData: vi.fn((width: number, height: number): ImageData => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: "srgb",
  })),
  fillRect: vi.fn(),
  putImageData: vi.fn((image: ImageData) => {
    lastPaintedImage = image
  }),
  drawImage: vi.fn(),
}

function settings(frameBytes: number): OpticalTransferSettings {
  return { txFps: 60, frameBytes, ecc: "L", gridCodes: 1 }
}

async function providePreparedPart(sender: MockSenderWorker): Promise<PackedOpticalFile> {
  let request: Extract<SenderWorkerInput, { type: "copyPreparedPart" }> | undefined
  await waitFor(() => {
    const requests = sender.messages.filter(
      (message): message is Extract<SenderWorkerInput, { type: "copyPreparedPart" }> =>
        message.type === "copyPreparedPart",
    )
    request = requests[requests.length - 1]
    expect(request).toBeDefined()
  })
  const confirmedRequest = request
  if (!confirmedRequest) throw new Error("APNG export did not request a prepared part")
  const part: PackedOpticalFile = {
    container: Uint8Array.of(1, 2, 3),
    containerTag: 1n,
    compression: "none",
    originalSize: 3,
    transmittedSize: 3,
    part: { index: confirmedRequest.part, count: 0, transferId: undefined },
  }
  act(() => sender.emit({ type: "preparedPart", requestId: confirmedRequest.requestId, part }))
  return part
}

async function completeApngExport(exporter: MockSenderWorker, result: ApngExportResult): Promise<void> {
  act(() => exporter.emit({ type: "chunks", parts: [new TextEncoder().encode("apng")] }))
  await waitFor(() => expect(exporter.messages).toContainEqual({ type: "chunksAck" }))
  act(() => exporter.emit({ type: "done", ...result }))
}

beforeEach(() => {
  wasmMocks.configuredWasmVariant = "auto"
  MockSenderWorker.instances = []
  loadZstdEncoderWasmModule.mockClear()
  lastPaintedImage = undefined
  vi.stubGlobal("Worker", MockSenderWorker)
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  )
  vi.stubGlobal("cancelAnimationFrame", vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId) =>
    contextId === "webgl2" ? null : (canvasContext as unknown as CanvasRenderingContext2D),
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, "fullscreenElement")
  Reflect.deleteProperty(document, "exitFullscreen")
})

describe("OpticalTransferPanel", () => {
  it.each([
    [500, 24],
    [1000, 48],
    [1450, 64],
    [1850, 64],
    [2331, 64],
    [2953, 64],
  ])("prepares %i-byte QR streams with a %i MiB part budget", async (frameBytes, mib) => {
    const file = new File(["payload"], "payload.zip", { type: "application/zip" })
    render(<OpticalTransferPanel file={file} settings={settings(frameBytes)} receiverUrl="https://example.com" />)
    act(() => MockSenderWorker.instances[0].emit({ type: "payloadReady" }))
    await waitFor(() =>
      expect(MockSenderWorker.instances[0].messages).toContainEqual(
        expect.objectContaining({ type: "partition", partPayloadSize: mib * 1024 * 1024 }),
      ),
    )
  })

  it("passes the selected part budget through standalone byte preparation", async () => {
    wasmMocks.configuredWasmVariant = "scalar"
    const file = new File(["payload"], "payload.zip", { type: "application/zip" })
    render(<OpticalTransferPanel file={file} settings={settings(500)} receiverUrl="https://example.com" />)
    await waitFor(() =>
      expect(MockSenderWorker.instances[0].messages).toContainEqual(expect.objectContaining({ type: "prepareBytes" })),
    )
    act(() => MockSenderWorker.instances[0].emit({ type: "payloadReady" }))
    expect(latestPartition(MockSenderWorker.instances[0]).partPayloadSize).toBe(24 * 1024 * 1024)
  })

  it("reports QR preparation failures to the host error modal", async () => {
    const file = new File(["payload"], "deleted.txt", { type: "text/plain" })
    const onError = vi.fn<(error: Error) => void>()
    render(
      <OpticalTransferPanel
        file={file}
        settings={settings(2953)}
        receiverUrl="https://example.com/qr-receiver"
        onTransferError={onError}
      />,
    )
    const worker = MockSenderWorker.instances[0]

    act(() =>
      worker.emit({
        type: "error",
        message:
          'Could not read "deleted.txt". It may have been moved, deleted, or changed since it was selected. ' +
          "Select the file again and retry.",
      }),
    )

    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onError.mock.calls[0][0].message).toContain('Could not read "deleted.txt"')
  })

  it("does not load the zstd encoder for a file that will not be compressed", async () => {
    const file = new File([new Uint8Array(1024)], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    await waitFor(() => expect(sender.messages.some((message) => message.type === "init")).toBe(true))
    expect(loadZstdEncoderWasmModule).not.toHaveBeenCalled()
    expect(sender.messages.find((message) => message.type === "init")).toEqual({
      type: "init",
      wasmModule: nanoRQModule,
      xxhashWasmModule: xxhashModule,
    })
  })

  it("loads the zstd encoder for a compression candidate", async () => {
    const file = new File(["compressible text\n".repeat(100)], "payload.txt", { type: "text/plain" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    await waitFor(() => expect(sender.messages.some((message) => message.type === "init")).toBe(true))
    expect(loadZstdEncoderWasmModule).toHaveBeenCalledOnce()
    expect(sender.messages.find((message) => message.type === "init")).toEqual({
      type: "init",
      wasmModule: nanoRQModule,
      xxhashWasmModule: xxhashModule,
      zstdEncoderWasmModule: zstdModule,
    })
  })

  it("keeps queued QR cells bit-packed and reuses one RGBA buffer while painting", async () => {
    let animationTick: FrameRequestCallback | undefined
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        animationTick = callback
        return 1
      }),
    )
    canvasContext.putImageData.mockClear()
    vi.stubGlobal("devicePixelRatio", 1)
    vi.stubGlobal("innerWidth", 100)
    vi.stubGlobal("innerHeight", 100)
    const file = new File(["payload"], "payload.bin", { type: "application/octet-stream" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const worker = MockSenderWorker.instances[0]

    prepareSender(worker, {
      containerSize: 4096,
      compression: "zstd",
      originalSize: 8192,
      transmittedSize: 4096,
      partCount: 1,
    })
    let session = 0
    await waitFor(() => {
      const configured = worker.messages.find(
        (message): message is Extract<SenderWorkerInput, { type: "configure" }> => message.type === "configure",
      )
      expect(configured).toBeDefined()
      if (configured) session = configured.session
    })
    const initialGenerate = worker.messages.find(
      (message): message is Extract<SenderWorkerInput, { type: "generate" }> => message.type === "generate",
    )
    expect(initialGenerate?.count).toBe(1)
    const canvas = screen.getByLabelText("Animated multi-code QR data stream")
    expect(canvas).toHaveAttribute("hidden")
    expect(screen.getByLabelText("Generating first QR frame")).toBeInTheDocument()

    const monochrome = new Uint8Array(116).fill(0xff) // 29×29 version-1 QR with four-module margins
    monochrome[0] = 0x7f // first pixel black, the rest white
    act(() => {
      worker.emit({
        type: "batch",
        session,
        monochromeBuffers: [monochrome.buffer],
        version: 1,
        modules: 21,
        part: 0,
        partBytes: 4096,
      })
    })
    const primingRequests = worker.messages.filter(
      (message): message is Extract<SenderWorkerInput, { type: "generate" }> => message.type === "generate",
    )
    expect(primingRequests.map(({ count }) => count)).toEqual([1, 2])
    expect(canvasContext.putImageData).not.toHaveBeenCalled()
    expect(canvas).toHaveAttribute("hidden")

    const firstTickAt = performance.now() + 20
    act(() => animationTick?.(firstTickAt))

    expect(lastPaintedImage).toBeDefined()
    expect([...(lastPaintedImage?.data.slice(0, 8) ?? [])]).toEqual([0, 0, 0, 255, 255, 255, 255, 255])
    expect(canvasContext.createImageData).toHaveBeenCalledOnce()
    const renderedCanvas = screen.getByLabelText("Animated multi-code QR data stream")
    expect(renderedCanvas).not.toHaveAttribute("hidden")
    expect(renderedCanvas).toHaveAttribute("width", "29")
    expect(renderedCanvas).toHaveAttribute("height", "29")
    expect(renderedCanvas).toHaveStyle({ width: "58px", height: "58px" })
    expect(screen.queryByLabelText("Generating first QR frame")).not.toBeInTheDocument()
    expect(renderedCanvas).toHaveStyle({ imageRendering: "pixelated" })
    expect(renderedCanvas.parentElement).toHaveClass("overflow-hidden")
    expect(renderedCanvas.parentElement).not.toHaveClass("overflow-auto")
    vi.stubGlobal("innerWidth", 103)
    vi.stubGlobal("innerHeight", 97)
    vi.stubGlobal("devicePixelRatio", 2)
    await userEvent.click(renderedCanvas.parentElement!)
    expect(renderedCanvas.parentElement).toHaveClass("fixed", "inset-0")
    expect(renderedCanvas).toHaveStyle({ width: "130.5px", height: "130.5px" })
    expect(renderedCanvas.style.transform).toBe("")
    const stage = renderedCanvas.parentElement as HTMLDivElement
    let fullscreenElement: Element | null = null
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement })
    const requestFullscreen = vi.fn(() => {
      fullscreenElement = stage
      document.dispatchEvent(new Event("fullscreenchange"))
      return Promise.resolve()
    })
    const exitFullscreen = vi.fn(() => {
      fullscreenElement = null
      document.dispatchEvent(new Event("fullscreenchange"))
      return Promise.resolve()
    })
    Object.defineProperty(stage, "requestFullscreen", { configurable: true, value: requestFullscreen })
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen })
    vi.stubGlobal("innerWidth", 200)
    vi.stubGlobal("innerHeight", 200)
    await userEvent.click(screen.getByRole("button", { name: "Enter browser fullscreen" }))
    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(stage).toHaveClass("fixed")
    expect(renderedCanvas).toHaveStyle({ width: "275.5px", height: "275.5px" })
    vi.stubGlobal("innerWidth", 103)
    vi.stubGlobal("innerHeight", 97)
    await userEvent.click(screen.getByRole("button", { name: "Exit browser fullscreen" }))
    expect(exitFullscreen).toHaveBeenCalledOnce()
    expect(stage).toHaveClass("fixed")
    expect(renderedCanvas).toHaveStyle({ width: "130.5px", height: "130.5px" })
    const streamDetails = screen.getByText("60 fps × 1").parentElement
    expect(screen.getByText("2953 B/Frame")).toBeInTheDocument()
    expect(screen.getByText("zstd on · -50.0%")).toBeInTheDocument()
    expect(streamDetails?.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Export APNG" }))

    const second = new Uint8Array(116).fill(0xff)
    const third = new Uint8Array(116).fill(0xff)
    const fourth = new Uint8Array(116).fill(0xff)
    act(() => {
      worker.emit({
        type: "batch",
        session,
        monochromeBuffers: [second.buffer, third.buffer, fourth.buffer],
        version: 1,
        modules: 21,
        part: 0,
        partBytes: 4096,
      })
    })
    // One whole frame late: discard sequence 1, paint sequence 2 and retain
    // sequence 3 as lookahead instead of displaying stale data in a burst.
    act(() => animationTick?.(firstTickAt + 40))
    const generateMessages = worker.messages.filter(
      (message): message is Extract<SenderWorkerInput, { type: "generate" }> => message.type === "generate",
    )
    expect(generateMessages[generateMessages.length - 1]?.recycledBuffers).toContain(monochrome.buffer)
    expect(generateMessages[generateMessages.length - 1]?.recycledBuffers).toContain(second.buffer)
  })

  it("recovers after a frame-capacity error by preparing the larger part budget", async () => {
    const file = new File(["payload"], "payload.bin", { type: "application/octet-stream" })
    const view = render(
      <OpticalTransferPanel file={file} settings={settings(500)} receiverUrl="https://example.com/qr-receiver" />,
    )
    const worker = MockSenderWorker.instances[0]

    prepareSender(worker, {
      containerSize: 40 * 1024 * 1024,
      compression: "none",
      originalSize: 40 * 1024 * 1024,
      transmittedSize: 40 * 1024 * 1024,
      partCount: 1,
    })

    expect(await screen.findByRole("alert")).toHaveTextContent("Raise Bytes / Frame")
    const canvas = screen.getByLabelText("Animated multi-code QR data stream")
    expect(canvas.parentElement).toHaveAttribute("hidden")

    view.rerender(
      <OpticalTransferPanel file={file} settings={settings(1000)} receiverUrl="https://example.com/qr-receiver" />,
    )

    expect(MockSenderWorker.instances).toHaveLength(1)
    expect(worker.messages).not.toContainEqual({ type: "dispose" })
    expect(worker.messages.some((message) => message.type === "configure")).toBe(false)
    prepareSender(worker, {
      containerSize: 40 * 1024 * 1024,
      compression: "none",
      originalSize: 40 * 1024 * 1024,
      transmittedSize: 40 * 1024 * 1024,
      partCount: 1,
    })

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(worker.messages.some((message) => message.type === "configure" && message.frameBytes === 1000)).toBe(true)
    })
    expect(screen.getByLabelText("Animated multi-code QR data stream").parentElement).not.toHaveAttribute("hidden")
  })

  it("ignores stale partition successes and errors when a budget changes back", () => {
    const file = new File(["payload"], "payload.zip", { type: "application/zip" })
    const view = render(<OpticalTransferPanel file={file} settings={settings(500)} receiverUrl="https://example.com" />)
    const sender = MockSenderWorker.instances[0]
    act(() => sender.emit({ type: "payloadReady" }))
    const first = latestPartition(sender)
    view.rerender(<OpticalTransferPanel file={file} settings={settings(1000)} receiverUrl="https://example.com" />)
    const second = latestPartition(sender)
    view.rerender(<OpticalTransferPanel file={file} settings={settings(500)} receiverUrl="https://example.com" />)
    const latest = latestPartition(sender)
    const summary: PreparedOpticalFile = {
      containerSize: 100,
      originalSize: 100,
      transmittedSize: 100,
      compression: "none",
      partCount: 1,
    }
    act(() => {
      sender.emit({ ...first, type: "prepared", file: summary })
      sender.emit({ type: "error", requestId: second.requestId, message: "obsolete partition error" })
    })
    expect(screen.queryByRole("button", { name: "Export APNG" })).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(sender.messages.some((message) => message.type === "configure")).toBe(false)
    act(() => sender.emit({ ...latest, type: "prepared", file: summary }))
    expect(screen.getByRole("button", { name: "Export APNG" })).toBeInTheDocument()
    expect(MockSenderWorker.instances).toHaveLength(1)
  })

  it("repartitions on budget changes and exports only the newly prepared parts", async () => {
    const file = new File(["payload"], "payload.zip", { type: "application/zip" })
    const view = render(
      <OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com" />,
    )
    const sender = MockSenderWorker.instances[0]
    const previousSummary = prepareSender(sender, {
      containerSize: 64 * 1024 * 1024,
      originalSize: 70 * 1024 * 1024,
      transmittedSize: 70 * 1024 * 1024,
      compression: "none",
      partCount: 2,
    })

    // All offered capacities >= 1450 retain the same prepared 64 MiB parts.
    view.rerender(<OpticalTransferPanel file={file} settings={settings(1450)} receiverUrl="https://example.com" />)
    expect(MockSenderWorker.instances).toHaveLength(1)
    expect(sender.messages.some((message) => message.type === "configure" && message.frameBytes === 1450)).toBe(true)

    view.rerender(<OpticalTransferPanel file={file} settings={settings(500)} receiverUrl="https://example.com" />)
    expect(MockSenderWorker.instances).toHaveLength(1)
    expect(sender.messages).not.toContainEqual({ type: "dispose" })
    expect(screen.queryByRole("button", { name: "Export APNG" })).not.toBeInTheDocument()
    const configuredBefore = sender.messages.filter((message) => message.type === "configure").length
    act(() => sender.emit(previousSummary))
    expect(sender.messages.filter((message) => message.type === "configure")).toHaveLength(configuredBefore)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()

    prepareSender(sender, {
      containerSize: 24 * 1024 * 1024,
      originalSize: 70 * 1024 * 1024,
      transmittedSize: 70 * 1024 * 1024,
      compression: "none",
      partCount: 3,
    })
    await waitFor(() =>
      expect(sender.messages.some((message) => message.type === "configure" && message.frameBytes === 500)).toBe(true),
    )
    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    const exporter = MockSenderWorker.instances[1]
    const part = await providePreparedPart(sender)
    await waitFor(() =>
      expect(exporter.messages).toContainEqual(
        expect.objectContaining({
          type: "export",
          frameBytes: 500,
          partIndex: 0,
          part,
        }),
      ),
    )
    expect(sender.messages.filter((message) => message.type === "prepare")).toHaveLength(1)
  })

  it("exports one QR carousel in a separate worker without occupying the live sender", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    prepareSender(sender, {
      containerSize: 4096,
      compression: "none",
      originalSize: 4096,
      transmittedSize: 4096,
      partCount: 1,
    })
    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    const exporter = MockSenderWorker.instances[1]
    const part = await providePreparedPart(sender)

    await waitFor(() =>
      expect(exporter.messages).toContainEqual({
        type: "export",
        wasmModule: nanoRQModule,
        fileName: file.name,
        part,
        frameBytes: 2953,
        ecc: "L",
        gridCodes: 1,
        txFps: 60,
        extraPercent: DEFAULT_EXPORT_EXTRA_PERCENT,
        qrScale: APNG_QR_SCALE,
      }),
    )
    expect(sender.messages.some((message) => message.type === "export")).toBe(false)
    act(() => exporter.emit({ type: "progress", completed: 4, total: 10 }))
    expect(screen.getByRole("progressbar", { name: "APNG export progress" })).toHaveValue(4)
    expect(screen.getByText("40%")).toBeInTheDocument()

    await completeApngExport(exporter, {
      filename: "photo.jpg.qr.png",
      frames: 10,
      symbols: 10,
      width: 740,
      height: 740,
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(createObjectUrl).toHaveBeenCalledWith(expect.objectContaining({ size: 4, type: "image/png" }))
    expect(click).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Exported 740×740 APNG with 10 frames containing 10 QR symbols.",
    )
    expect(sender.terminate).not.toHaveBeenCalled()
    expect(exporter.terminate).toHaveBeenCalledOnce()
  })

  it("ends APNG export when the sender cannot provide its prepared part", async () => {
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]
    prepareSender(sender, {
      containerSize: 4096,
      compression: "none",
      originalSize: 4096,
      transmittedSize: 4096,
      partCount: 1,
    })

    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    const exporter = MockSenderWorker.instances[1]
    let request: Extract<SenderWorkerInput, { type: "copyPreparedPart" }> | undefined
    await waitFor(() => {
      request = sender.messages.find(
        (message): message is Extract<SenderWorkerInput, { type: "copyPreparedPart" }> =>
          message.type === "copyPreparedPart",
      )
      expect(request).toBeDefined()
    })
    act(() => sender.emit({ type: "preparedPartError", requestId: request!.requestId, message: "Part read failed." }))

    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(screen.queryByRole("button", { name: "Cancel export" })).not.toBeInTheDocument()
    expect(screen.getByText("APNG export failed: Part read failed.")).toBeInTheDocument()
    expect(exporter.terminate).toHaveBeenCalledOnce()
    expect(sender.terminate).not.toHaveBeenCalled()
  })

  it("exports an APNG at the QR scale chosen in the export toolbar", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    prepareSender(sender, {
      containerSize: 4096,
      compression: "none",
      originalSize: 4096,
      transmittedSize: 4096,
      partCount: 1,
    })

    const scaleSelect = screen.getByLabelText("APNG export scale")
    expect(scaleSelect).toHaveValue("4")
    await userEvent.selectOptions(scaleSelect, "2")

    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    const exporter = MockSenderWorker.instances[1]
    const part = await providePreparedPart(sender)

    await waitFor(() =>
      expect(exporter.messages).toMatchObject([{ type: "export", fileName: file.name, part, qrScale: 2 }]),
    )

    await completeApngExport(exporter, {
      filename: "photo.jpg.qr.png",
      frames: 10,
      symbols: 10,
      width: 740,
      height: 740,
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(createObjectUrl).toHaveBeenCalled()
  })

  it("cancels an APNG export by terminating only its dedicated worker", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    prepareSender(sender, {
      containerSize: 4096,
      compression: "none",
      originalSize: 4096,
      transmittedSize: 4096,
      partCount: 1,
    })
    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    const exporter = MockSenderWorker.instances[1]
    await providePreparedPart(sender)

    act(() => exporter.emit({ type: "progress", completed: 4, total: 10 }))
    expect(screen.queryByRole("button", { name: "Export APNG" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Cancel export" }))

    expect(exporter.terminate).toHaveBeenCalledOnce()
    expect(sender.terminate).not.toHaveBeenCalled()
    expect(screen.queryByRole("progressbar", { name: "APNG export progress" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel export" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled()
    expect(screen.getByRole("status")).toHaveTextContent("APNG export cancelled.")

    exporter.emit({
      type: "done",
      filename: "late.qr.png",
      frames: 10,
      symbols: 10,
      width: 740,
      height: 740,
    })
    expect(createObjectUrl).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    expect(MockSenderWorker.instances).toHaveLength(3)
    const nextExporter = MockSenderWorker.instances[2]
    const nextPart = await providePreparedPart(sender)
    await waitFor(() =>
      expect(nextExporter.messages).toMatchObject([{ type: "export", fileName: file.name, part: nextPart }]),
    )
  })

  it("shows a manual segment bar and switches parts on demand", async () => {
    const file = new File(["payload"], "payload.bin", { type: "application/octet-stream" })
    render(
      <OpticalTransferPanel
        file={file}
        settings={{ ...settings(2953), txFps: 30, gridCodes: 9 }}
        receiverUrl="https://example.com/qr-receiver"
      />,
    )
    const worker = MockSenderWorker.instances[0]

    prepareSender(worker, {
      containerSize: 4096,
      compression: "none",
      originalSize: 8192,
      transmittedSize: 8192,
      partCount: 3,
    })
    expect(screen.getByLabelText("跳转到第几段")).toHaveValue(1)
    expect(screen.getByText("/3")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "上一段" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "下一段" })).toBeEnabled()

    let session = 0
    await waitFor(() => {
      const configured = worker.messages.find(
        (message): message is Extract<SenderWorkerInput, { type: "configure" }> => message.type === "configure",
      )
      expect(configured).toBeDefined()
      if (configured) session = configured.session
    })
    expect(
      worker.messages.find(
        (message): message is Extract<SenderWorkerInput, { type: "generate" }> => message.type === "generate",
      )?.count,
    ).toBe(9)
    act(() => {
      worker.emit({
        type: "batch",
        session,
        monochromeBuffers: Array.from({ length: 9 }, () => new Uint8Array(20).buffer),
        version: 1,
        modules: 2,
        part: 0,
        partBytes: 24 * 1024 * 1024,
      })
    })
    expect(screen.getByText("Streaming payload.bin · part 1/3 · 24.00 MB.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "下一段" }))
    expect(worker.messages).toContainEqual({ type: "switchPart", session, part: 1 })
    const generateAfterSwitch = worker.messages.filter(
      (message): message is Extract<SenderWorkerInput, { type: "generate" }> => message.type === "generate",
    )
    expect(generateAfterSwitch[generateAfterSwitch.length - 1]?.count).toBe(9)
    expect(screen.getByLabelText("跳转到第几段")).toHaveValue(2)
    act(() => {
      worker.emit({
        type: "batch",
        session,
        monochromeBuffers: Array.from({ length: 9 }, () => new Uint8Array(20).buffer),
        version: 1,
        modules: 2,
        part: 1,
        partBytes: 1234,
      })
    })
    expect(screen.getByText("Streaming payload.bin · part 2/3 · 1.21 KB.")).toBeInTheDocument()

    const jumpInput = screen.getByLabelText("跳转到第几段")
    await userEvent.clear(jumpInput)
    await userEvent.type(jumpInput, "3")
    await userEvent.click(screen.getByRole("button", { name: "跳转" }))
    expect(worker.messages).toContainEqual({ type: "switchPart", session, part: 2 })
    expect(screen.getByLabelText("跳转到第几段")).toHaveValue(3)
    expect(screen.getByRole("button", { name: "下一段" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "上一段" })).toBeEnabled()

    await userEvent.click(screen.getByRole("button", { name: "上一段" }))
    expect(worker.messages).toContainEqual({ type: "switchPart", session, part: 1 })
    expect(screen.getByLabelText("跳转到第几段")).toHaveValue(2)
  })

  it("exports the currently selected part as an APNG with a part-numbered filename", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    prepareSender(sender, {
      containerSize: 4096,
      compression: "none",
      originalSize: 8192,
      transmittedSize: 8192,
      partCount: 3,
    })
    await waitFor(() => {
      const configured = sender.messages.find(
        (message): message is Extract<SenderWorkerInput, { type: "configure" }> => message.type === "configure",
      )
      expect(configured).toBeDefined()
    })

    // Move to part 3 (zero-based 2) with the nav bar, then export.
    await userEvent.click(screen.getByRole("button", { name: "下一段" }))
    await userEvent.click(screen.getByRole("button", { name: "下一段" }))
    expect(screen.getByLabelText("跳转到第几段")).toHaveValue(3)

    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }))
    const exporter = MockSenderWorker.instances[1]
    const part = await providePreparedPart(sender)

    await waitFor(() =>
      expect(exporter.messages).toMatchObject([{ type: "export", fileName: file.name, part, partIndex: 2 }]),
    )

    await completeApngExport(exporter, {
      filename: "photo.jpg.qr.003.png",
      frames: 10,
      symbols: 10,
      width: 740,
      height: 740,
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(createObjectUrl).toHaveBeenCalledWith(expect.objectContaining({ size: 4, type: "image/png" }))
    expect(click).toHaveBeenCalledOnce()
  })
})
