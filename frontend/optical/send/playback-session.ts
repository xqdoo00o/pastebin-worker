import { monochromeByteLength } from "../shared/monochrome.js"
import { gridDims, TRANSFER_QR_MARGIN } from "../shared/qr.js"
import type { SenderWorkerOutput } from "../shared/worker-messages.js"
import { createMonochromeCanvasRenderer, type MonochromeCanvasRenderer } from "./monochrome-canvas-renderer.js"

const LOOKAHEAD = 3

interface OpticalPlaybackSessionOptions {
  canvas: HTMLCanvasElement
  fallbackCanvas: HTMLCanvasElement
  stage: HTMLDivElement
  worker: Worker
  session: number
  frameBytes: number
  ecc: string
  txFps: number
  gridCodes: number
  partCount: number
  initialPart: number
  isFullscreen: () => boolean
  onError: (cause: unknown) => void
  onReady: () => void
  onRendererBackend: (backend: MonochromeCanvasRenderer["backend"]) => void
  onStatus: (status: string) => void
  onStreamInfo: (version: number) => void
  fileName: string
}

/** Imperative playback engine for one configured optical stream. React owns
 * lifecycle and visible state; this class owns the worker queue, renderer,
 * animation clock and recycled transfer buffers. */
export class OpticalPlaybackSession {
  private readonly canvas: HTMLCanvasElement
  private readonly fallbackCanvas: HTMLCanvasElement
  private readonly stage: HTMLDivElement
  private readonly worker: Worker
  private readonly session: number
  private readonly frameBytes: number
  private readonly ecc: string
  private readonly txFps: number
  private readonly gridCodes: number
  private readonly partCount: number
  private readonly isFullscreen: () => boolean
  private readonly onError: (cause: unknown) => void
  private readonly onReady: () => void
  private readonly onRendererBackend: (backend: MonochromeCanvasRenderer["backend"]) => void
  private readonly onStatus: (status: string) => void
  private readonly onStreamInfo: (version: number) => void
  private readonly fileName: string
  private readonly gridColumns: number
  private readonly gridRows: number
  private readonly cells: (Uint8Array<ArrayBuffer> | null)[]
  private readonly queue: Uint8Array<ArrayBuffer>[] = []
  private readonly recycledBuffers: ArrayBuffer[] = []
  private queueHead = 0
  private currentPart: number
  private version: number | undefined
  private modules = 0
  private renderer: MonochromeCanvasRenderer | undefined
  private stopped = false
  private generatorFailed = false
  private firstFramePainted = false
  private animationFrame = 0
  private partSwitchPending = false
  private requestPendingPart: number | undefined
  private targetQueueSize: number
  private cellCursor = 0
  private nextAt = performance.now()
  private scheduleResyncPending = true

  constructor(options: OpticalPlaybackSessionOptions) {
    this.canvas = options.canvas
    this.fallbackCanvas = options.fallbackCanvas
    this.stage = options.stage
    this.worker = options.worker
    this.session = options.session
    this.frameBytes = options.frameBytes
    this.ecc = options.ecc
    this.txFps = options.txFps
    this.gridCodes = options.gridCodes
    this.partCount = options.partCount
    this.currentPart = options.initialPart
    this.isFullscreen = options.isFullscreen
    this.onError = options.onError
    this.onReady = options.onReady
    this.onRendererBackend = options.onRendererBackend
    this.onStatus = options.onStatus
    this.onStreamInfo = options.onStreamInfo
    this.fileName = options.fileName
    const dims = gridDims(options.gridCodes)
    this.gridColumns = dims.cols
    this.gridRows = dims.rows
    this.cells = new Array<Uint8Array<ArrayBuffer> | null>(options.gridCodes).fill(null)
    // Return one complete grid as soon as possible, then fill the normal
    // lookahead after the first batch can already be painted.
    this.targetQueueSize = options.gridCodes
  }

  start(): void {
    try {
      this.worker.postMessage({
        type: "configure",
        session: this.session,
        frameBytes: this.frameBytes,
        ecc: this.ecc,
      })
      this.requestMore()
      this.animationFrame = requestAnimationFrame(this.tick)
      window.addEventListener("resize", this.resize)
    } catch (cause) {
      this.fail(cause)
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.teardown()
  }

  private teardown(): void {
    cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
    window.removeEventListener("resize", this.resize)
    const renderer = this.renderer
    this.renderer = undefined
    renderer?.destroy()
    this.queue.length = 0
    this.queueHead = 0
    this.cells.fill(null)
    this.recycledBuffers.length = 0
    this.requestPendingPart = undefined
    // Drop the canvas backing store as well as the renderer's GPU resources.
    this.canvas.width = 1
    this.canvas.height = 1
    this.canvas.style.width = ""
    this.canvas.style.height = ""
    this.fallbackCanvas.width = 1
    this.fallbackCanvas.height = 1
    this.fallbackCanvas.style.width = ""
    this.fallbackCanvas.style.height = ""
  }

  resize = (): void => {
    if (!this.modules || this.stopped) return
    const canvas = this.renderer?.canvas ?? this.canvas
    const dpr = window.devicePixelRatio || 1
    const cell = this.modules + 2 * TRANSFER_QR_MARGIN
    const totalWidth = cell * this.gridColumns
    const totalHeight = cell * this.gridRows
    let budgetWidth: number
    let budgetHeight: number
    if (this.isFullscreen()) {
      budgetWidth = Math.max(1, this.stage.clientWidth || window.innerWidth)
      budgetHeight = Math.max(1, this.stage.clientHeight || window.innerHeight)
      const physicalScale = Math.max(
        1,
        Math.floor(Math.min((budgetWidth * dpr) / totalWidth, (budgetHeight * dpr) / totalHeight) + Number.EPSILON),
      )
      canvas.style.width = `${(totalWidth * physicalScale) / dpr}px`
      canvas.style.height = `${(totalHeight * physicalScale) / dpr}px`
      return
    }
    const availableWidth =
      this.stage.clientWidth || this.stage.parentElement?.getBoundingClientRect().width || window.innerWidth
    budgetWidth = Math.max(1, Math.min(availableWidth - 16, window.innerWidth - 24))
    budgetHeight = Math.max(1, Math.min(window.innerHeight * 0.78, (budgetWidth * this.gridRows) / this.gridColumns))
    const scale = Math.max(
      1,
      Math.floor(Math.min((budgetWidth * dpr) / totalWidth, (budgetHeight * dpr) / totalHeight)),
    )
    const nativeWidth = (totalWidth * scale) / dpr
    const nativeHeight = (totalHeight * scale) / dpr
    const stretch = Math.min(1, budgetWidth / nativeWidth, budgetHeight / nativeHeight)
    canvas.style.width = `${nativeWidth * stretch}px`
    canvas.style.height = `${nativeHeight * stretch}px`
  }

  handleMessage = (message: SenderWorkerOutput): void => {
    if (this.stopped || message.type === "prepared") return
    if (message.type !== "batch" && message.type !== "error") return
    if (message.type === "error") {
      if (message.session === this.session) {
        this.requestPendingPart = undefined
        this.fail(message.message)
      }
      return
    }
    if (message.session !== this.session) return
    if (message.part !== this.currentPart) {
      this.recycledBuffers.push(...message.monochromeBuffers)
      // A batch requested before a part switch can arrive after the new
      // part's request. Do not clear that newer request's pending state.
      if (this.requestPendingPart === message.part) this.requestPendingPart = undefined
      this.requestMore()
      return
    }
    this.requestPendingPart = undefined
    try {
      if (this.partSwitchPending) {
        this.partSwitchPending = false
        this.nextAt = performance.now()
        this.scheduleResyncPending = true
        this.onStatus(this.streamStatusText())
      }
      const cell = message.modules + 2 * TRANSFER_QR_MARGIN
      const expectedBytes = monochromeByteLength(cell, cell)
      for (const buffer of message.monochromeBuffers) {
        if (buffer.byteLength !== expectedBytes) throw new Error("The QR generator returned an invalid image buffer.")
        this.queue.push(new Uint8Array(buffer))
      }
      if (this.version === undefined || message.modules !== this.modules) {
        this.renderer?.destroy()
        this.version = message.version
        this.modules = message.modules
        this.cells.fill(null)
        this.renderer = createMonochromeCanvasRenderer(
          this.canvas,
          {
            cellSize: cell,
            columns: this.gridColumns,
            rows: this.gridRows,
            onFallback: () => {
              this.onRendererBackend("2d")
              this.resize()
              this.cells.forEach((image, index) => {
                if (image) this.renderer?.updateCell(image, index)
              })
              this.renderer?.render()
            },
            onError: this.fail,
          },
          this.fallbackCanvas,
        )
        this.onRendererBackend(this.renderer.backend)
        this.resize()
        this.onStreamInfo(message.version)
        this.onStatus(this.streamStatusText())
        this.nextAt = performance.now()
        this.scheduleResyncPending = true
      }
      this.targetQueueSize = LOOKAHEAD * this.gridCodes
      this.requestMore()
    } catch (cause) {
      this.fail(cause)
    }
  }

  switchPart(target: number): boolean {
    if (this.stopped || this.generatorFailed || target === this.currentPart || target < 0 || target >= this.partCount) {
      return false
    }
    this.currentPart = target
    this.discardQueued(this.queuedCount())
    for (const image of this.cells) {
      if (image) this.recycledBuffers.push(image.buffer)
    }
    this.cells.fill(null)
    this.cellCursor = 0
    this.requestPendingPart = undefined
    this.targetQueueSize = this.gridCodes
    this.partSwitchPending = true
    this.onStatus(`Switching to part ${target + 1}/${this.partCount}…`)
    try {
      this.worker.postMessage({ type: "switchPart", session: this.session, part: target })
      this.requestMore()
      return true
    } catch (cause) {
      this.fail(cause)
      return false
    }
  }

  private streamStatusText(): string {
    return this.partCount > 1
      ? `Streaming ${this.fileName} · part ${this.currentPart + 1}/${this.partCount}.`
      : `Streaming ${this.fileName}.`
  }

  private fail = (cause: unknown): void => {
    if (this.generatorFailed || this.stopped) return
    this.generatorFailed = true
    this.stopped = true
    this.teardown()
    this.onError(cause)
  }

  private queuedCount(): number {
    return this.queue.length - this.queueHead
  }

  private takeQueued(): Uint8Array<ArrayBuffer> | undefined {
    if (this.queueHead >= this.queue.length) return undefined
    const image = this.queue[this.queueHead++]
    if (this.queueHead === this.queue.length) {
      this.queue.length = 0
      this.queueHead = 0
    }
    return image
  }

  private discardQueued(count: number): void {
    for (let discarded = 0; discarded < count; discarded++) {
      const image = this.takeQueued()
      if (!image) return
      this.recycledBuffers.push(image.buffer)
    }
  }

  private requestMore(): void {
    if (this.requestPendingPart !== undefined || this.generatorFailed || this.stopped) return
    const count = this.targetQueueSize - this.queuedCount()
    if (count <= 0) return
    this.requestPendingPart = this.currentPart
    try {
      const reusable = this.recycledBuffers.splice(0)
      this.worker.postMessage({ type: "generate", session: this.session, count, recycledBuffers: reusable }, reusable)
    } catch (cause) {
      this.fail(cause)
    }
  }

  private tick = (now: number): void => {
    if (this.stopped || this.generatorFailed) return
    this.animationFrame = requestAnimationFrame(this.tick)
    const interval = 1000 / this.txFps
    const subInterval = interval / this.gridCodes
    if (now < this.nextAt) return
    const lateness = now - this.nextAt
    if (this.scheduleResyncPending) {
      // The first animation callback after startup/part loading should paint
      // immediately instead of treating worker preparation time as a miss.
      this.nextAt = now
      this.scheduleResyncPending = false
    } else if (lateness > interval) {
      const missedFrames = Math.floor(lateness / subInterval)
      this.discardQueued(missedFrames)
      this.nextAt += missedFrames * subInterval
    }
    let painted = false
    while (now >= this.nextAt) {
      const image = this.takeQueued()
      if (!image) {
        this.requestMore()
        this.nextAt = now + subInterval
        break
      }
      const previous = this.cells[this.cellCursor]
      this.cells[this.cellCursor] = image
      if (previous) this.recycledBuffers.push(previous.buffer)
      if (!this.renderer) {
        this.fail(new Error("The QR canvas renderer is not initialized."))
        return
      }
      this.renderer.updateCell(image, this.cellCursor)
      painted = true
      this.cellCursor = (this.cellCursor + 1) % this.gridCodes
      this.nextAt += subInterval
    }
    if (painted) {
      this.renderer?.render()
      if (!this.firstFramePainted) {
        this.firstFramePainted = true
        this.onReady()
      }
      this.requestMore()
    }
  }
}
