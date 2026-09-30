import { errorMessage } from "./errors.js"
import type { ManagedFile, OPFSTemporaryFile } from "./opfs.js"

export class OPFSOutputError extends Error {
  constructor(readonly cause: unknown) {
    super(errorMessage(cause))
    this.name = "OPFSOutputError"
  }
}

/** Own the bytes and cleanup for one memory-backed or OPFS-backed output. */
export class FileOutputSink {
  private parts: Blob[] = []
  private completed?: ManagedFile

  constructor(private temporary?: OPFSTemporaryFile) {}

  async write(data: BlobPart): Promise<void> {
    if (!this.temporary) {
      this.parts.push(new Blob([data]))
      return
    }
    try {
      await this.temporary.write(data)
    } catch (error) {
      throw new OPFSOutputError(error)
    }
  }

  async spill(temporary: OPFSTemporaryFile, beforeWrite?: () => void): Promise<void> {
    this.temporary = temporary
    for (const part of this.parts) {
      beforeWrite?.()
      await this.write(part)
    }
    this.parts = []
  }

  async finish(filename: string, type: string): Promise<ManagedFile> {
    if (this.temporary) {
      try {
        this.completed = await this.temporary.finish(filename, type)
      } catch (error) {
        throw new OPFSOutputError(error)
      }
    } else {
      this.completed = { file: new File(this.parts, filename, { type }) }
    }
    this.temporary = undefined
    this.parts = []
    return this.completed
  }

  async abort(): Promise<void> {
    this.parts = []
    await this.temporary?.abort()
    this.temporary = undefined
    await this.completed?.cleanup?.()
    this.completed = undefined
  }
}
