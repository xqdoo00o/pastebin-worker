import { afterEach, describe, it, expect, vi } from "vitest"
import { ChunkCryptoSession, encrypt, decrypt, genKey, encodeKey, decodeKey } from "../utils/encryption.js"
import type { EncryptionScheme } from "../../shared/constants.js"
import {
  createEncryptionHeader,
  encryptedFileSize,
  ENCRYPTION_HEADER_SIZE,
  ENCRYPTION_PART_SIZE,
  ENCRYPTION_TAG_SIZE,
  firstEncryptionPlaintextSize,
  followingEncryptionPlaintextSize,
  parseEncryptionHeader,
} from "../utils/encryptionCore.js"

function randArray(len: number): Uint8Array {
  const arr = new Uint8Array(len)
  for (let offset = 0; offset < arr.length; offset += 65_536) {
    crypto.getRandomValues(arr.subarray(offset, Math.min(arr.length, offset + 65_536)))
  }
  return arr
}

function genRandStr(length: number): string {
  return Array.from(randArray(length), (value) => String.fromCharCode(32 + (value % 95))).join("")
}

class MockCryptoWorker {
  static instances: MockCryptoWorker[] = []
  static constructionError: Error | undefined
  static initializeError: Error | undefined

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly messages: { type: string }[] = []
  readonly terminate = vi.fn()
  transformError: Error | undefined

  constructor() {
    if (MockCryptoWorker.constructionError) throw MockCryptoWorker.constructionError
    MockCryptoWorker.instances.push(this)
  }

  postMessage(message: { type: string }): void {
    this.messages.push(message)
    if (message.type === "initialize" && MockCryptoWorker.initializeError) throw MockCryptoWorker.initializeError
    if (message.type !== "initialize" && this.transformError) throw this.transformError
  }

  emitError(message: string): ErrorEvent {
    const event = new ErrorEvent("error", { message, cancelable: true })
    this.onerror?.(event)
    return event
  }

  emitReady(): void {
    this.onmessage?.({ data: { type: "ready" } } as MessageEvent)
  }

  emitMessageError(): void {
    this.onmessageerror?.(new MessageEvent("messageerror"))
  }
}

afterEach(() => {
  MockCryptoWorker.instances = []
  MockCryptoWorker.constructionError = undefined
  MockCryptoWorker.initializeError = undefined
  vi.unstubAllGlobals()
})

describe("encrypt with AES-GCM", () => {
  it("uses the 24-byte PBE2 header and MPU-aligned encrypted chunks", async () => {
    const plaintextSize = firstEncryptionPlaintextSize() + followingEncryptionPlaintextSize() + 1
    const header = createEncryptionHeader(plaintextSize)
    const view = new DataView(header.bytes.buffer, header.bytes.byteOffset, header.bytes.byteLength)

    expect(header.bytes.byteLength).toStrictEqual(24)
    expect(new TextDecoder().decode(header.bytes.subarray(0, 4))).toStrictEqual("PBE2")
    expect(view.getUint32(4, false)).toStrictEqual(ENCRYPTION_PART_SIZE)
    expect(view.getBigUint64(8, false)).toStrictEqual(BigInt(plaintextSize))
    expect(parseEncryptionHeader(header.bytes).plaintextSize).toStrictEqual(plaintextSize)

    const key = await genKey("AES-GCM-CHUNKED")
    const encrypted = await encrypt("AES-GCM-CHUNKED", key, new Uint8Array(plaintextSize))
    expect(encrypted.byteLength).toStrictEqual(2 * ENCRYPTION_PART_SIZE + ENCRYPTION_TAG_SIZE + 1)
    expect(ENCRYPTION_HEADER_SIZE).toStrictEqual(24)
  })

  it("should decrypt to same message", async () => {
    const text = genRandStr(4096)
    const textBuffer = new TextEncoder().encode(text)

    const key = await genKey("AES-GCM-CHUNKED")

    const ciphertext = await encrypt("AES-GCM-CHUNKED", key, textBuffer)

    const decryptedBuffer = await decrypt("AES-GCM-CHUNKED", key, ciphertext)
    expect(decryptedBuffer).not.toBeNull()

    const decrypted = new TextDecoder().decode(decryptedBuffer!)

    expect(decrypted).toStrictEqual(text)
  })

  it("should report decryption error", async () => {
    const text = genRandStr(4096)
    const textBuffer = new TextEncoder().encode(text)

    const key = await genKey("AES-GCM-CHUNKED")
    const ciphertext = await encrypt("AES-GCM-CHUNKED", key, textBuffer)

    ciphertext[1024] = (ciphertext[1024] + 1) % 256

    const decryptedBuffer = await decrypt("AES-GCM-CHUNKED", key, ciphertext)
    expect(decryptedBuffer).toBeNull()
  })

  it("should encode and decode keys correctly", async () => {
    const key = await genKey("AES-GCM-CHUNKED")
    const plaintext = randArray(2048)
    const ciphertext = await encrypt("AES-GCM-CHUNKED", key, plaintext)

    for (let i = 0; i < 10; i++) {
      const encoded = await encodeKey(key)
      const decodedKey = await decodeKey("AES-GCM-CHUNKED", encoded)

      const decryptedBuffer = await decrypt("AES-GCM-CHUNKED", decodedKey, ciphertext)
      expect(decryptedBuffer).not.toBeNull()
      expect(decryptedBuffer!.length).toStrictEqual(plaintext.length)
      for (let i = 0; i < plaintext.length; i++) {
        expect(plaintext[i], `${i}-th bit of decrypted`).toStrictEqual(decryptedBuffer![i])
      }
    }
  })

  it("encrypts and authenticates content spanning multiple 5 MiB chunks", async () => {
    const plaintext = new Uint8Array(firstEncryptionPlaintextSize() + 257)
    const key = await genKey("AES-GCM-CHUNKED")
    const ciphertext = await encrypt("AES-GCM-CHUNKED", key, plaintext)

    expect(ciphertext.byteLength).toStrictEqual(encryptedFileSize(plaintext.byteLength))
    const decrypted = await decrypt("AES-GCM-CHUNKED", key, ciphertext)
    expect(decrypted?.byteLength).toStrictEqual(plaintext.byteLength)
    expect(decrypted?.[0]).toStrictEqual(0)
    expect(decrypted?.[decrypted.length - 1]).toStrictEqual(0)

    ciphertext[0] ^= 1
    await expect(decrypt("AES-GCM-CHUNKED", key, ciphertext)).resolves.toBeNull()
  })
})

describe("ChunkCryptoSession worker lifecycle", () => {
  it("terminates after a worker error and keeps the terminal error for future requests", async () => {
    vi.stubGlobal("Worker", MockCryptoWorker)
    const key = await genKey("AES-GCM-CHUNKED")
    const session = new ChunkCryptoSession(key, createEncryptionHeader(4))
    const worker = MockCryptoWorker.instances[0]
    worker.emitReady()
    const pending = session.encrypt(0, new ArrayBuffer(4))

    const event = worker.emitError("Encryption worker crashed")

    await expect(pending).rejects.toThrow("Encryption worker crashed")
    await expect(session.encrypt(0, new ArrayBuffer(4))).rejects.toThrow("Encryption worker crashed")
    expect(event.defaultPrevented).toStrictEqual(true)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    session.close()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it("treats a worker message deserialization error as terminal", async () => {
    vi.stubGlobal("Worker", MockCryptoWorker)
    const key = await genKey("AES-GCM-CHUNKED")
    const session = new ChunkCryptoSession(key, createEncryptionHeader(4))
    const worker = MockCryptoWorker.instances[0]
    worker.emitReady()
    const pending = session.encrypt(0, new ArrayBuffer(4))

    worker.emitMessageError()

    await expect(pending).rejects.toThrow("Encryption worker returned an invalid message")
    await expect(session.encrypt(0, new ArrayBuffer(4))).rejects.toThrow(
      "Encryption worker returned an invalid message",
    )
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it("falls back locally when worker construction or initialization fails", async () => {
    vi.stubGlobal("Worker", MockCryptoWorker)
    const key = await genKey("AES-GCM-CHUNKED")
    const header = createEncryptionHeader(4)

    MockCryptoWorker.constructionError = new Error("Unable to construct worker")
    const constructionFallback = new ChunkCryptoSession(key, header)
    await expect(constructionFallback.encrypt(0, new ArrayBuffer(4))).resolves.toHaveProperty("byteLength", 20)
    constructionFallback.close()

    MockCryptoWorker.constructionError = undefined
    MockCryptoWorker.initializeError = new Error("Unable to initialize worker")
    const initializationFallback = new ChunkCryptoSession(key, header)
    await expect(initializationFallback.encrypt(0, new ArrayBuffer(4))).resolves.toHaveProperty("byteLength", 20)
    expect(MockCryptoWorker.instances[0].terminate).toHaveBeenCalledTimes(1)
    initializationFallback.close()
  })

  it("keeps synchronous worker request failures terminal after initialization", async () => {
    vi.stubGlobal("Worker", MockCryptoWorker)
    const key = await genKey("AES-GCM-CHUNKED")
    const header = createEncryptionHeader(4)

    const session = new ChunkCryptoSession(key, header)
    const worker = MockCryptoWorker.instances[0]
    worker.emitReady()
    worker.transformError = new Error("Unable to post worker request")

    await expect(session.encrypt(0, new ArrayBuffer(4))).rejects.toThrow("Unable to post worker request")
    await expect(session.encrypt(0, new ArrayBuffer(4))).rejects.toThrow("Unable to post worker request")
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})

describe("unsupported scheme throws", () => {
  // simulate a future or corrupted scheme value reaching crypto helpers
  const bad = "RC4" as unknown as EncryptionScheme

  it("genKey rejects unknown scheme", async () => {
    await expect(genKey(bad)).rejects.toThrow(/Unsupported encryption scheme: RC4/)
  })

  it("encrypt rejects unknown scheme", async () => {
    const key = await genKey("AES-GCM-CHUNKED")
    await expect(encrypt(bad, key, new Uint8Array([1, 2, 3]))).rejects.toThrow(/Unsupported encryption scheme: RC4/)
  })

  it("decrypt rejects unknown scheme", async () => {
    const key = await genKey("AES-GCM-CHUNKED")
    await expect(decrypt(bad, key, new Uint8Array([1, 2, 3]))).rejects.toThrow(/Unsupported encryption scheme: RC4/)
  })

  it("decodeKey rejects unknown scheme", async () => {
    const key = await genKey("AES-GCM-CHUNKED")
    const encoded = await encodeKey(key)
    await expect(decodeKey(bad, encoded)).rejects.toThrow(/Unsupported encryption scheme: RC4/)
  })

  it("decodeKey rejects key with wrong byte length", async () => {
    // 10 base64 chars decode to ~7-8 bytes — neither 16, 24, nor 32.
    await expect(decodeKey("AES-GCM-CHUNKED", "abcdefghij")).rejects.toThrow(/AES-GCM key must decode to 32 bytes/)
  })
})
