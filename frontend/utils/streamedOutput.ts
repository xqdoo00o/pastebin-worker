import { OPFS_LARGE_FILE_THRESHOLD_BYTES } from "../../shared/constants.js"
import { FileOutputSink } from "./fileOutput.js"
import {
  createOPFSTemporaryFile,
  type ManagedFile,
  type OPFSTemporaryFile,
  type OPFSTemporaryFilePurpose,
} from "./opfs.js"

interface StreamedOutputOptions {
  thresholdBytes?: number
  purpose?: OPFSTemporaryFilePurpose
  createTemporaryFile?: (expectedSize: number, purpose: OPFSTemporaryFilePurpose) => Promise<OPFSTemporaryFile>
}

/** Snapshot streamed bytes as Blobs and spill to OPFS above the memory limit.
 * If creating the backing file fails, keep collecting in memory. */
export class StreamedFileCollector {
  private readonly output = new FileOutputSink()
  private diskBacked = false
  private totalBytes = 0
  private diskUnavailable = false
  private cancelled = false
  private finishing = false
  private work: Promise<void> = Promise.resolve()

  constructor(private readonly options: StreamedOutputOptions = {}) {}

  append(parts: BlobPart[]): Promise<void> {
    if (this.finishing || this.cancelled) return Promise.reject(new Error("The streamed output is closed."))
    const pending = this.work.then(async () => {
      this.throwIfCancelled()
      const batch = new Blob(parts)
      await this.output.write(batch)
      this.totalBytes += batch.size
      if (
        !this.diskBacked &&
        !this.diskUnavailable &&
        this.totalBytes > (this.options.thresholdBytes ?? OPFS_LARGE_FILE_THRESHOLD_BYTES)
      ) {
        const create = this.options.createTemporaryFile ?? createOPFSTemporaryFile
        let temporary: OPFSTemporaryFile
        try {
          temporary = await create(this.totalBytes, this.options.purpose ?? "download")
        } catch {
          this.throwIfCancelled()
          this.diskUnavailable = true
          return
        }
        this.diskBacked = true
        // Own the backing file before checking cancellation so abort can close it.
        await this.output.spill(temporary, () => this.throwIfCancelled())
        this.throwIfCancelled()
      }
    })
    this.work = pending.catch(() => undefined)
    return pending
  }

  finish(filename: string, type: string): Promise<ManagedFile> {
    if (this.finishing || this.cancelled) return Promise.reject(new Error("The streamed output is closed."))
    this.finishing = true
    const pending = this.work.then(async () => {
      this.throwIfCancelled()
      const completed = await this.output.finish(filename, type)
      this.throwIfCancelled()
      return completed
    })
    this.work = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  async abort(): Promise<void> {
    if (this.cancelled) return
    this.cancelled = true
    await this.work
    await this.output.abort()
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new DOMException("Output collection cancelled.", "AbortError")
  }
}
