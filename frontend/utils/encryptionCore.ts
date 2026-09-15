import { DIRECT_UPLOAD_MAX_BYTES } from "../../shared/constants.js"

export { CHUNKED_ENCRYPTION_SCHEME } from "../../shared/constants.js"
/** Serialized size of every non-final encrypted chunk and its matching MPU part. */
export const ENCRYPTION_PART_SIZE = DIRECT_UPLOAD_MAX_BYTES
export const ENCRYPTION_HEADER_SIZE = 24
export const ENCRYPTION_TAG_SIZE = 16

const HEADER_MAGIC = new TextEncoder().encode("PBE2")
const NONCE_PREFIX_SIZE = 8

export interface ChunkedEncryptionHeader {
  bytes: Uint8Array<ArrayBuffer>
  plaintextSize: number
  noncePrefix: Uint8Array<ArrayBuffer>
}

function assertPlaintextSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid encrypted plaintext size")
  if (encryptionChunkCount(size) > 0x1_0000_0000) throw new Error("Encrypted file has too many chunks")
}

export function firstEncryptionPlaintextSize(): number {
  return ENCRYPTION_PART_SIZE - ENCRYPTION_HEADER_SIZE - ENCRYPTION_TAG_SIZE
}

export function followingEncryptionPlaintextSize(): number {
  return ENCRYPTION_PART_SIZE - ENCRYPTION_TAG_SIZE
}

export function encryptionChunkCount(plaintextSize: number): number {
  assertPlaintextSizeWithoutChunkCount(plaintextSize)
  const remaining = Math.max(0, plaintextSize - firstEncryptionPlaintextSize())
  return 1 + Math.ceil(remaining / followingEncryptionPlaintextSize())
}

function assertPlaintextSizeWithoutChunkCount(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid encrypted plaintext size")
}

export function encryptionChunkBounds(plaintextSize: number, index: number): { start: number; end: number } {
  assertPlaintextSize(plaintextSize)
  const count = encryptionChunkCount(plaintextSize)
  if (!Number.isInteger(index) || index < 0 || index >= count)
    throw new Error(`Invalid encryption chunk index ${index}`)

  const firstSize = firstEncryptionPlaintextSize()
  if (index === 0) return { start: 0, end: Math.min(plaintextSize, firstSize) }
  const followingSize = followingEncryptionPlaintextSize()
  const start = firstSize + (index - 1) * followingSize
  return { start, end: Math.min(plaintextSize, start + followingSize) }
}

export function encryptedFileSize(plaintextSize: number): number {
  assertPlaintextSize(plaintextSize)
  return ENCRYPTION_HEADER_SIZE + plaintextSize + encryptionChunkCount(plaintextSize) * ENCRYPTION_TAG_SIZE
}

export function createEncryptionHeader(plaintextSize: number): ChunkedEncryptionHeader {
  assertPlaintextSize(plaintextSize)
  const bytes = new Uint8Array(ENCRYPTION_HEADER_SIZE)
  bytes.set(HEADER_MAGIC, 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, ENCRYPTION_PART_SIZE, false)
  view.setBigUint64(8, BigInt(plaintextSize), false)
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_SIZE))
  bytes.set(noncePrefix, 16)
  return { bytes, plaintextSize, noncePrefix: bytes.subarray(16, 16 + NONCE_PREFIX_SIZE) }
}

export function parseEncryptionHeader(bytes: Uint8Array): ChunkedEncryptionHeader {
  if (bytes.byteLength !== ENCRYPTION_HEADER_SIZE) throw new Error("Invalid encrypted file header length")
  for (let index = 0; index < HEADER_MAGIC.length; index += 1) {
    if (bytes[index] !== HEADER_MAGIC[index]) throw new Error("Invalid encrypted file header")
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, false) !== ENCRYPTION_PART_SIZE) throw new Error("Unsupported encrypted file parameters")
  const size = view.getBigUint64(8, false)
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Encrypted plaintext size is too large")
  const plaintextSize = Number(size)
  assertPlaintextSize(plaintextSize)
  const copiedHeader = new Uint8Array(bytes)
  return {
    bytes: copiedHeader,
    plaintextSize,
    noncePrefix: copiedHeader.subarray(16, 16 + NONCE_PREFIX_SIZE),
  }
}

function chunkIv(header: ChunkedEncryptionHeader, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  iv.set(header.noncePrefix, 0)
  new DataView(iv.buffer).setUint32(8, index, false)
  return iv
}

function chunkAdditionalData(header: ChunkedEncryptionHeader, index: number): Uint8Array<ArrayBuffer> {
  const additionalData = new Uint8Array(ENCRYPTION_HEADER_SIZE + 4)
  additionalData.set(header.bytes, 0)
  new DataView(additionalData.buffer).setUint32(ENCRYPTION_HEADER_SIZE, index, false)
  return additionalData
}

function expectedPlaintextLength(header: ChunkedEncryptionHeader, index: number): number {
  const { start, end } = encryptionChunkBounds(header.plaintextSize, index)
  return end - start
}

export async function encryptChunk(
  key: CryptoKey,
  header: ChunkedEncryptionHeader,
  index: number,
  plaintext: BufferSource,
): Promise<ArrayBuffer> {
  if (plaintext.byteLength !== expectedPlaintextLength(header, index)) {
    throw new Error(`Unexpected plaintext length for encryption chunk ${index}`)
  }
  return await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: chunkIv(header, index),
      additionalData: chunkAdditionalData(header, index),
      tagLength: 128,
    },
    key,
    plaintext,
  )
}

export async function decryptChunk(
  key: CryptoKey,
  header: ChunkedEncryptionHeader,
  index: number,
  ciphertext: BufferSource,
): Promise<ArrayBuffer> {
  const expectedLength = expectedPlaintextLength(header, index) + ENCRYPTION_TAG_SIZE
  if (ciphertext.byteLength !== expectedLength) {
    throw new Error(`Unexpected ciphertext length for encryption chunk ${index}`)
  }
  return await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: chunkIv(header, index),
      additionalData: chunkAdditionalData(header, index),
      tagLength: 128,
    },
    key,
    ciphertext,
  )
}
