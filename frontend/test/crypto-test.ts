import { ChunkCryptoSession } from "../utils/encryption.js"
import {
  createEncryptionHeader,
  encryptedFileSize,
  encryptionChunkBounds,
  encryptionChunkCount,
  ENCRYPTION_HEADER_SIZE,
} from "../utils/encryptionCore.js"

/** Assemble fixture ciphertext through the same chunk session used by uploads. */
export async function encryptForTest(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const header = createEncryptionHeader(plaintext.byteLength)
  const session = new ChunkCryptoSession(key, header, false)
  const output = new Uint8Array(encryptedFileSize(plaintext.byteLength))
  output.set(header.bytes)
  let offset = ENCRYPTION_HEADER_SIZE
  try {
    for (let index = 0; index < encryptionChunkCount(plaintext.byteLength); index += 1) {
      const { start, end } = encryptionChunkBounds(plaintext.byteLength, index)
      const encrypted = new Uint8Array(await session.encrypt(index, plaintext.slice(start, end).buffer))
      output.set(encrypted, offset)
      offset += encrypted.byteLength
    }
    return output
  } finally {
    session.close()
  }
}
