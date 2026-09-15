import { errorMessage } from "../../utils/errors.js"
import { estimateTransferProgress, expectedRaptorQOverhead, formatDuration } from "../shared/progress.js"
import type { FountainSnapshot, FountainWorkerOutput } from "../shared/fountain.js"
import { unpackFile, type OpticalFile, type OpticalPart } from "../shared/protocol.js"
import { ensureXXHashReady } from "../../wasm/xxhash-loader.js"
import { ensureZstdDecoderReady } from "../../wasm/zstd-loader.js"
import { OpticalPartTransferMismatchError } from "./part-assembler.js"
import type { MultipartOpticalAssembler } from "./part-assembler.js"
import type { FountainWorkerClient } from "./fountain-client.js"
import type { OpticalReceiverRuntime, ReceivedFileResource, ReceiverSession } from "./receiver-runtime.js"
import type { ReceiveMode, ReceiverView } from "./receiver-view.js"

interface ReceiverTransferOptions {
  progressBar: HTMLElement
  runtime: OpticalReceiverRuntime
  session: ReceiverSession<ReceiveMode>
  view: ReceiverView
  assembler: MultipartOpticalAssembler
  fountainClient: FountainWorkerClient
  receivedFile: ReceivedFileResource
  setReceiverPhase: (phase: "receiving") => void
  renderReceiverStatus: () => void
  showError: (message: string) => void
  offerRetry: (message: string) => void
  teardownReceiver: () => Promise<void>
  suspendReceiver: () => Promise<void>
  releaseDecodeWorkers: () => void
  resetReceiver: () => void
}

/** Owns fountain progress, container completion, and multipart persistence.
 * Source selection and media lifecycle stay in receiver-controller. */
export class ReceiverTransferCoordinator {
  private verdictShown: string | null = null

  constructor(private readonly options: ReceiverTransferOptions) {}

  resetProgress(): void {
    this.options.runtime.resetTransfer()
    this.options.fountainClient.resetProgress()
    this.verdictShown = null
  }

  handleMessage(message: Exclude<FountainWorkerOutput, { type: "processed" }>): void {
    const { runtime, session } = this.options
    if (session.done || message.type === "ready") return
    if (message.type === "verdict") {
      if (message.message !== null) {
        this.verdictShown = message.message
        this.options.showError(message.message)
        if (message.reason === "transfer" && session.mode === "apng") {
          runtime.rejectApngAttempt(new OpticalPartTransferMismatchError(message.message))
        }
      } else if (this.verdictShown !== null) {
        this.verdictShown = null
        this.options.renderReceiverStatus()
      }
      return
    }
    if (message.type === "error") {
      void this.options.teardownReceiver().then(() => this.options.offerRetry(message.message))
      return
    }
    this.applySnapshot(message.snapshot, message.type === "progress" && message.started)
    if (message.type === "complete") {
      const seconds = runtime.elapsed()
      void this.finish(new Uint8Array(message.container), message.part, seconds)
    }
  }

  updateProgress(): void {
    const { runtime, view } = this.options
    const decoder = runtime.snapshot
    if (!decoder) return
    const elapsed = runtime.elapsed()
    const estimate = estimateTransferProgress(decoder.k, decoder.framesNew, elapsed)
    const collectedSymbols = Math.min(decoder.k, decoder.framesNew)
    const percent = estimate.fraction * 100
    const shownPercent = percent < 10 ? percent.toFixed(1) : percent.toFixed(0)
    view.patchProgress({ percent, label: `${shownPercent}% · ${collectedSymbols}/${decoder.k} symbols` })
    const rate = decoder.framesNew >= 4 ? ` · ${this.goodputKbs(elapsed).toFixed(1)} KB/s` : ""
    view.patchProgress({
      eta:
        (estimate.etaSeconds === undefined
          ? estimate.phase === "decoding"
            ? "Decoding…"
            : "Estimating time…"
          : `About ${formatDuration(estimate.etaSeconds)}`) + rate,
    })
  }

  resetParts(): void {
    this.options.fountainClient.expectTransfer(undefined)
    void this.options.assembler.reset().catch(() => undefined)
    this.options.view.patch({ partProgress: undefined })
  }

  renderPartStatus(): void {
    const { assembler, fountainClient, view } = this.options
    const progress = assembler.progress()
    fountainClient.expectTransfer(assembler.expectedTransfer())
    view.patch({ partProgress: progress ?? undefined })
  }

  private applySnapshot(snapshot: FountainSnapshot, started: boolean): void {
    const { runtime, view } = this.options
    const streamStarted = runtime.applySnapshot(snapshot, started)
    if (runtime.phase !== "receiving") this.options.setReceiverPhase("receiving")
    if (streamStarted) view.patchProgress({ visible: true })
    this.updateProgress()
  }

  private goodputKbs(elapsed: number): number {
    const decoder = this.options.runtime.snapshot
    if (!decoder) return 0
    return (decoder.framesNew * decoder.symbolLen) / expectedRaptorQOverhead(decoder.k) / 1024 / Math.max(0.1, elapsed)
  }

  private waitForProgressCompletion(): Promise<void> {
    const bar = this.options.progressBar
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        bar.removeEventListener("transitionend", finish)
        resolve()
      }
      const timeout = window.setTimeout(finish, 350)
      bar.addEventListener("transitionend", finish, { once: true })
    })
  }

  private async accumulatePart(file: OpticalFile) {
    if (file.compression === "zstd-fragment") await ensureZstdDecoderReady()
    await ensureXXHashReady()
    const completed = await this.options.assembler.accept(file)
    this.renderPartStatus()
    return completed
  }

  private async finish(container: Uint8Array, part: OpticalPart, seconds: number): Promise<void> {
    const { assembler, receivedFile, releaseDecodeWorkers, resetReceiver, runtime, session, view } = this.options
    session.complete()
    const progressCompleted = this.waitForProgressCompletion()
    const unpacked = unpackFile(container, part, ensureZstdDecoderReady).then(
      (file) => ({ ok: true as const, file }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const decoder = runtime.snapshot
    view.patchProgress({
      percent: 100,
      label: decoder ? `100% · ${decoder.k}/${decoder.k} symbols` : "100%",
      eta: `${formatDuration(seconds)} total`,
    })
    await progressCompleted
    view.patch({ previewVisible: false })
    await this.options.suspendReceiver()

    let file: OpticalFile
    try {
      const unpackResult = await unpacked
      if (!unpackResult.ok) throw unpackResult.error
      file = unpackResult.file
    } catch (error) {
      releaseDecodeWorkers()
      view.patchProgress({ error: true, eta: "Transfer failed" })
      this.options.showError(errorMessage(error))
      view.patch({ result: { kind: "failure" } })
      return
    }

    try {
      assembler.assertCompatibleTransfer(file)
    } catch (error) {
      if (!(error instanceof OpticalPartTransferMismatchError)) throw error
      session.markDelivered()
      receivedFile.release()
      resetReceiver()
      this.options.showError(error.message)
      return
    }

    if (file.part.count !== 0) {
      session.markDelivered()
      try {
        const stored = await this.accumulatePart(file)
        if (!stored) {
          resetReceiver()
          return
        }
        releaseDecodeWorkers()
        this.resetParts()
        receivedFile.setStoredFile(stored)
        view.patch({
          introVisible: false,
          settingsVisible: false,
          result: {
            kind: "file",
            file: stored.file,
            containerBytes: stored.transmittedSize,
            seconds,
            wasCompressed: stored.wasCompressed,
            stored: true,
          },
        })
      } catch (error) {
        if (error instanceof OpticalPartTransferMismatchError) {
          receivedFile.release()
          resetReceiver()
          this.options.showError(error.message)
          return
        }
        releaseDecodeWorkers()
        receivedFile.release()
        this.resetParts()
        view.patchProgress({ error: true, eta: "Transfer failed" })
        this.options.showError(errorMessage(error))
        view.patch({ result: { kind: "failure" } })
      }
      return
    }

    session.markDelivered()
    releaseDecodeWorkers()
    this.resetParts()
    view.patch({
      introVisible: false,
      settingsVisible: false,
      result: { kind: "file", file, containerBytes: container.length, seconds, stored: false },
    })
  }
}
