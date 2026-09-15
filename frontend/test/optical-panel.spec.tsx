import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { userEvent } from "@testing-library/user-event"
import { OpticalTransferPanel } from "../components/OpticalTransferPanel.js"
import type {
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
    nanoRQModule: {},
    zstdModule,
    xxhashModule,
    loadZstdEncoderWasmModule: vi.fn(() => Promise.resolve(zstdModule)),
  }
})
const { nanoRQModule, zstdModule, xxhashModule, loadZstdEncoderWasmModule } = wasmMocks

vi.mock("../optical/shared/wasm-module.js", () => ({
  configuredWasmVariant: "auto",
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
  compressZstd: () => Promise.resolve(new Uint8Array(0)),
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

beforeEach(() => {
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
})

describe("OpticalTransferPanel", () => {
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

    act(() => {
      worker.emit({
        type: "prepared",
        file: { containerSize: 4096, compression: "zstd", originalSize: 8192, transmittedSize: 4096, partCount: 1 },
      })
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

    const monochrome = new Uint8Array(20).fill(0xff) // 10×10 pixels at a two-byte row stride
    monochrome[0] = 0x7f // first pixel black, the rest white
    act(() => {
      worker.emit({
        type: "batch",
        session,
        monochromeBuffers: [monochrome.buffer],
        version: 1,
        modules: 2,
        part: 0,
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
    expect(renderedCanvas).toHaveAttribute("width", "10")
    expect(renderedCanvas).toHaveAttribute("height", "10")
    expect(renderedCanvas).toHaveStyle({ width: "70px", height: "70px" })
    expect(screen.queryByLabelText("Generating first QR frame")).not.toBeInTheDocument()
    expect(renderedCanvas).toHaveStyle({ imageRendering: "pixelated" })
    expect(renderedCanvas.parentElement).toHaveClass("overflow-hidden")
    expect(renderedCanvas.parentElement).not.toHaveClass("overflow-auto")
    vi.stubGlobal("innerWidth", 103)
    vi.stubGlobal("innerHeight", 97)
    vi.stubGlobal("devicePixelRatio", 2)
    await userEvent.click(renderedCanvas.parentElement!)
    expect(renderedCanvas.parentElement).toHaveClass("fixed", "inset-0")
    expect(renderedCanvas).toHaveStyle({ width: "95px", height: "95px" })
    expect(renderedCanvas.style.transform).toBe("")
    const streamDetails = screen.getByText("60 fps × 1").parentElement
    expect(screen.getByText("2953 B/Frame")).toBeInTheDocument()
    expect(screen.getByText("zstd on · -50.0%")).toBeInTheDocument()
    expect(streamDetails?.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Export APNG" }))

    const second = new Uint8Array(20).fill(0xff)
    const third = new Uint8Array(20).fill(0xff)
    const fourth = new Uint8Array(20).fill(0xff)
    act(() => {
      worker.emit({
        type: "batch",
        session,
        monochromeBuffers: [second.buffer, third.buffer, fourth.buffer],
        version: 1,
        modules: 2,
        part: 0,
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

  it("keeps its canvas mounted and recovers after a frame-capacity error", async () => {
    const file = new File(["payload"], "payload.bin", { type: "application/octet-stream" })
    const view = render(
      <OpticalTransferPanel file={file} settings={settings(500)} receiverUrl="https://example.com/qr-receiver" />,
    )
    const worker = MockSenderWorker.instances[0]

    act(() => {
      worker.emit({
        type: "prepared",
        file: {
          containerSize: 40 * 1024 * 1024,
          compression: "none",
          originalSize: 40 * 1024 * 1024,
          transmittedSize: 40 * 1024 * 1024,
          partCount: 1,
        },
      })
    })

    expect(await screen.findByRole("alert")).toHaveTextContent("Raise Bytes / Frame")
    const canvas = screen.getByLabelText("Animated multi-code QR data stream")
    expect(canvas.parentElement).toHaveAttribute("hidden")

    view.rerender(
      <OpticalTransferPanel file={file} settings={settings(1000)} receiverUrl="https://example.com/qr-receiver" />,
    )

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(worker.messages.some((message) => message.type === "configure" && message.frameBytes === 1000)).toBe(true)
    })
    expect(canvas.parentElement).not.toHaveAttribute("hidden")
  })

  it("exports one QR carousel in a separate worker without occupying the live sender", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    act(() => {
      sender.emit({
        type: "prepared",
        file: {
          containerSize: 4096,
          compression: "none",
          originalSize: 4096,
          transmittedSize: 4096,
          partCount: 1,
        },
      })
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

    const blob = new Blob(["apng"], { type: "image/png" })
    act(() =>
      exporter.emit({
        type: "done",
        blob,
        filename: "photo.jpg.qr.png",
        frames: 10,
        symbols: 10,
        width: 740,
        height: 740,
      }),
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(createObjectUrl).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Exported 740×740 APNG with 10 frames containing 10 QR symbols.",
    )
    expect(sender.terminate).not.toHaveBeenCalled()
    expect(exporter.terminate).toHaveBeenCalledOnce()
  })

  it("exports an APNG at the QR scale chosen in the export toolbar", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    act(() => {
      sender.emit({
        type: "prepared",
        file: {
          containerSize: 4096,
          compression: "none",
          originalSize: 4096,
          transmittedSize: 4096,
          partCount: 1,
        },
      })
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

    act(() =>
      exporter.emit({
        type: "done",
        blob: new Blob(["apng"], { type: "image/png" }),
        filename: "photo.jpg.qr.png",
        frames: 10,
        symbols: 10,
        width: 740,
        height: 740,
      }),
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(createObjectUrl).toHaveBeenCalled()
  })

  it("cancels an APNG export by terminating only its dedicated worker", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:qr-apng")
    const file = new File(["payload"], "photo.jpg", { type: "image/jpeg" })
    render(<OpticalTransferPanel file={file} settings={settings(2953)} receiverUrl="https://example.com/qr-receiver" />)
    const sender = MockSenderWorker.instances[0]

    act(() => {
      sender.emit({
        type: "prepared",
        file: {
          containerSize: 4096,
          compression: "none",
          originalSize: 4096,
          transmittedSize: 4096,
          partCount: 1,
        },
      })
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
      blob: new Blob(["late result"], { type: "image/png" }),
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

    act(() => {
      worker.emit({
        type: "prepared",
        file: { containerSize: 4096, compression: "none", originalSize: 8192, transmittedSize: 8192, partCount: 3 },
      })
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

    await userEvent.click(screen.getByRole("button", { name: "下一段" }))
    expect(worker.messages).toContainEqual({ type: "switchPart", session, part: 1 })
    const generateAfterSwitch = worker.messages.filter(
      (message): message is Extract<SenderWorkerInput, { type: "generate" }> => message.type === "generate",
    )
    expect(generateAfterSwitch[generateAfterSwitch.length - 1]?.count).toBe(9)
    expect(screen.getByLabelText("跳转到第几段")).toHaveValue(2)

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

    act(() => {
      sender.emit({
        type: "prepared",
        file: { containerSize: 4096, compression: "none", originalSize: 8192, transmittedSize: 8192, partCount: 3 },
      })
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

    const blob = new Blob(["apng"], { type: "image/png" })
    act(() =>
      exporter.emit({
        type: "done",
        blob,
        filename: "photo.jpg.qr.003.png",
        frames: 10,
        symbols: 10,
        width: 740,
        height: 740,
      }),
    )
    await waitFor(() => expect(screen.getByRole("button", { name: "Export APNG" })).toBeEnabled())
    expect(createObjectUrl).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledOnce()
  })
})
