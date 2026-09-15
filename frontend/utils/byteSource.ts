import { FileReadError } from "./errors.js"

export interface RandomAccessByteSource {
  readonly size: number
  read(start: number, end: number): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>
}

export function blobByteSource(blob: Blob): RandomAccessByteSource {
  return {
    size: blob.size,
    async read(start, end) {
      return new Uint8Array(await blob.slice(start, end).arrayBuffer())
    },
  }
}

/** Random-access source for a user-selected file with stable read errors. */
export function fileByteSource(file: File): RandomAccessByteSource {
  const source = blobByteSource(file)
  return {
    size: source.size,
    async read(start, end) {
      try {
        return await source.read(start, end)
      } catch (cause) {
        throw new FileReadError(file.name, cause)
      }
    },
  }
}

/** Read a complete user-selected file through its native full-read path.
 * WebKit can fail an otherwise valid full-range `File.slice()` read. */
export async function readFileBytes(file: File, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted()
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    signal?.throwIfAborted()
    return bytes
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted()
    throw new FileReadError(file.name, cause)
  }
}

export async function readFileSlice(
  file: File,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted()
  try {
    const bytes = await fileByteSource(file).read(start, end)
    signal?.throwIfAborted()
    return bytes
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted()
    throw cause
  }
}

export function arrayBufferByteSource(data: ArrayBuffer): RandomAccessByteSource {
  const bytes = new Uint8Array(data)
  return {
    size: bytes.byteLength,
    read(start, end) {
      return bytes.subarray(start, end)
    },
  }
}

/** Read one source range sequentially without materializing it in full. */
export async function* readByteSourceRangeChunks(
  source: RandomAccessByteSource,
  start: number,
  end: number,
  chunkSize: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError("Chunk size must be a positive integer.")
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.size) {
    throw new RangeError("Byte source range is invalid.")
  }

  for (let offset = start; offset < end; offset += chunkSize) {
    signal?.throwIfAborted()
    const chunkEnd = Math.min(end, offset + chunkSize)
    const chunk = await source.read(offset, chunkEnd)
    signal?.throwIfAborted()
    if (chunk.byteLength !== chunkEnd - offset) throw new Error("Byte source returned an unexpected number of bytes.")
    yield chunk
  }
}

/** Read a complete random-access source sequentially. */
export function readByteSourceChunks(
  source: RandomAccessByteSource,
  chunkSize: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  return readByteSourceRangeChunks(source, 0, source.size, chunkSize, signal)
}
