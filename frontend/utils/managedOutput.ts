import { asArrayBufferView } from "../../shared/bytes.js"
import { FileOutputSink, OPFSOutputError } from "./fileOutput.js"
import {
  createOPFSTemporaryFile,
  type ManagedFile,
  type OPFSTemporaryFile,
  type OPFSTemporaryFilePurpose,
} from "./opfs.js"

export type OutputChunkWriter = (chunk: Uint8Array) => Promise<void>

export interface BuildManagedOutputOptions {
  filename: string
  mediaType: string
  expectedSize: number
  opfsThreshold: number
  purpose: OPFSTemporaryFilePurpose
  signal?: AbortSignal
  /** Produce the complete output. This may run twice when an OPFS write fails,
   * so it must create fresh codec/worker state on every invocation. */
  produce(writeChunk: OutputChunkWriter): Promise<void>
}

async function buildToTarget(
  options: BuildManagedOutputOptions,
  temporaryFile?: OPFSTemporaryFile,
): Promise<ManagedFile> {
  const output = new FileOutputSink(temporaryFile)
  const writeChunk: OutputChunkWriter = async (chunk) => {
    if (chunk.byteLength === 0) return
    options.signal?.throwIfAborted()
    await output.write(asArrayBufferView(chunk))
    options.signal?.throwIfAborted()
  }

  try {
    await options.produce(writeChunk)
    options.signal?.throwIfAborted()
    const completed = await output.finish(options.filename, options.mediaType)
    options.signal?.throwIfAborted()
    return completed
  } catch (error) {
    await output.abort()
    throw error
  }
}

/** Build a complete File in memory or OPFS. If OPFS becomes unavailable while
 * writing, discard the partial file and replay the producer once in memory. */
export async function buildManagedOutput(options: BuildManagedOutputOptions): Promise<ManagedFile> {
  options.signal?.throwIfAborted()
  const useOPFS = options.expectedSize > options.opfsThreshold
  if (!useOPFS) return await buildToTarget(options)

  let temporaryFile: OPFSTemporaryFile
  try {
    temporaryFile = await createOPFSTemporaryFile(options.expectedSize, options.purpose)
  } catch {
    options.signal?.throwIfAborted()
    return await buildToTarget(options)
  }

  try {
    options.signal?.throwIfAborted()
  } catch (error) {
    await temporaryFile.abort()
    throw error
  }

  try {
    return await buildToTarget(options, temporaryFile)
  } catch (error) {
    options.signal?.throwIfAborted()
    if (!(error instanceof OPFSOutputError)) throw error
    return await buildToTarget(options)
  }
}
