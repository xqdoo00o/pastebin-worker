import {
  maxP2PControlMessageLength,
  verificationBlockSize,
  type DataMessage,
  type P2PVerificationManifest,
} from "./protocol.js"
import { createStreamingXXH3, xxh3, xxh3Chunks, type StreamingXXH3 } from "../../wasm/xxhash-runtime.js"
import { fileByteSource, readByteSourceChunks } from "../byteSource.js"

export const maxVerificationRepairAttempts = 3

export interface BlockHashState {
  size: number
  hashes: string[]
  hasher?: StreamingXXH3
}

export function createBlockHashState(hashes: string[] = []): BlockHashState {
  return { size: 0, hashes }
}

function digestCurrentBlock(state: BlockHashState, reuse: boolean): string {
  const hasher = state.hasher
  if (!hasher) throw new Error("P2P verification hash state is incomplete.")
  try {
    return hashToHex(hasher.digest())
  } finally {
    if (reuse) hasher.reset()
    else {
      hasher.free()
      state.hasher = undefined
    }
  }
}

export function* verificationHashChunks(
  hashes: readonly string[],
  maxMessageLength: number,
): Generator<Extract<DataMessage, { type: "verification-chunk" }>> {
  const limit = Math.min(maxP2PControlMessageLength, Math.floor(maxMessageLength))
  let startIndex = 0
  while (startIndex < hashes.length) {
    const emptyMessage: Extract<DataMessage, { type: "verification-chunk" }> = {
      type: "verification-chunk",
      startIndex,
      hashes: [],
    }
    let serializedLength = JSON.stringify(emptyMessage).length
    let endIndex = startIndex
    while (endIndex < hashes.length) {
      const hashLength = JSON.stringify(hashes[endIndex]).length
      const addedLength = hashLength + (endIndex === startIndex ? 0 : 1)
      if (serializedLength + addedLength > limit) break
      serializedLength += addedLength
      endIndex += 1
    }
    if (endIndex === startIndex) throw new Error("P2P control message limit is too small for a verification hash.")
    yield { ...emptyMessage, hashes: hashes.slice(startIndex, endIndex) }
    startIndex = endIndex
  }
}

export function* verificationManifestMessages(
  manifest: P2PVerificationManifest,
  maxMessageLength: number,
): Generator<DataMessage> {
  const limit = Math.min(maxP2PControlMessageLength, Math.floor(maxMessageLength))
  const inlineMessage: DataMessage = { type: "done", verification: manifest }
  if (JSON.stringify(inlineMessage).length <= limit) {
    yield inlineMessage
    return
  }

  const startMessage: DataMessage = {
    type: "verification-start",
    blockSize: manifest.blockSize,
    hashCount: manifest.hashes.length,
  }
  if (JSON.stringify(startMessage).length > limit) {
    throw new Error("P2P control message limit is too small for transfer verification.")
  }
  yield startMessage
  yield* verificationHashChunks(manifest.hashes, limit)
  yield { type: "done" }
}

function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, "0")
}

/** Hash one verification block with official XXH3-64. Multiple received data
 * channel parts are fed through the streaming API without concatenation. */
export async function xxh3Hex(parts: readonly ArrayBuffer[]): Promise<string> {
  if (parts.length === 1) return hashToHex(await xxh3(new Uint8Array(parts[0])))
  return hashToHex(await xxh3Chunks(parts.map((part) => new Uint8Array(part))))
}

export async function hashFileVerificationBlocks(file: File, signal?: AbortSignal): Promise<string[]> {
  const state = createBlockHashState()
  try {
    for await (const chunk of readByteSourceChunks(fileByteSource(file), verificationBlockSize, signal)) {
      await appendHashData(state, chunk)
    }
    return finishHashData(state)
  } finally {
    disposeHashData(state)
  }
}

export function sliceArrayBuffer(buffer: ArrayBuffer, start: number, end: number): ArrayBuffer {
  return start === 0 && end === buffer.byteLength ? buffer : buffer.slice(start, end)
}

export async function appendHashData(
  state: BlockHashState,
  chunk: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<void> {
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  let chunkOffset = 0
  while (chunkOffset < bytes.byteLength) {
    state.hasher ??= await createStreamingXXH3()
    const takeBytes = Math.min(verificationBlockSize - state.size, bytes.byteLength - chunkOffset)
    state.hasher.update(bytes.subarray(chunkOffset, chunkOffset + takeBytes))
    state.size += takeBytes
    chunkOffset += takeBytes
    if (state.size === verificationBlockSize) {
      state.hashes.push(digestCurrentBlock(state, true))
      state.size = 0
    }
  }
}

export function finishHashData(state: BlockHashState): string[] {
  if (state.size > 0) {
    state.hashes.push(digestCurrentBlock(state, false))
    state.size = 0
  } else {
    state.hasher?.free()
    state.hasher = undefined
  }
  return state.hashes
}

export function disposeHashData(state: BlockHashState | undefined): void {
  state?.hasher?.free()
  if (state) {
    state.hasher = undefined
    state.size = 0
  }
}

export function verificationHashIndices(manifest: P2PVerificationManifest, indices?: Iterable<number>): number[] {
  if (indices === undefined) return manifest.hashes.map((_, index) => index)

  const validIndices = new Set<number>()
  for (const rawIndex of indices) {
    const index = Math.floor(rawIndex)
    if (Number.isSafeInteger(index) && index >= 0 && index < manifest.hashes.length) validIndices.add(index)
  }
  return [...validIndices].sort((left, right) => left - right)
}

export function verificationBlockByteLength(index: number, totalBytes: number): number {
  const start = index * verificationBlockSize
  if (!Number.isSafeInteger(index) || index < 0 || start >= totalBytes) return 0
  return Math.min(verificationBlockSize, totalBytes - start)
}

export function verificationBlocksByteLength(indices: Iterable<number>, totalBytes: number): number {
  let bytes = 0
  for (const index of indices) bytes += verificationBlockByteLength(index, totalBytes)
  return bytes
}
