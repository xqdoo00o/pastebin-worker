import {
  createEncryptionHeader,
  decryptChunk,
  encryptChunk,
  encryptedFileSize,
  encryptionChunkBounds,
  encryptionChunkCount,
  ENCRYPTION_HEADER_SIZE,
  ENCRYPTION_TAG_SIZE,
  parseEncryptionHeader,
  type ChunkedEncryptionHeader,
} from "./encryptionCore.js"
import { CHUNKED_ENCRYPTION_SCHEME, type EncryptionScheme } from "../../shared/constants.js"
import { base64UrlToBytes, bytesToBase64Url } from "../../shared/encoding.js"
import { WorkerRequestMap } from "./workerRequests.js"

export { CHUNKED_ENCRYPTION_SCHEME, type EncryptionScheme } from "../../shared/constants.js"

const cryptoWorkerThreshold = 1024 * 1024
const cryptoWorkerInitializationTimeoutMs = 5_000

interface WorkerReady {
  type: "ready"
}

interface WorkerResult {
  type: "result"
  id: number
  data?: ArrayBuffer
  error?: string
}

type WorkerResponse = WorkerReady | WorkerResult

function asWorkerError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === "string" && error.length > 0 ? error : fallback)
}

export class ChunkCryptoSession {
  private worker?: Worker
  private workerReady: Promise<boolean> = Promise.resolve(false)
  private cancelWorkerInitialization?: () => void
  private readonly requests = new WorkerRequestMap<ArrayBuffer>()
  private closed = false
  private terminalError?: Error

  constructor(
    private readonly key: CryptoKey,
    readonly header: ChunkedEncryptionHeader,
    useWorker = true,
  ) {
    if (useWorker && typeof window !== "undefined" && typeof Worker !== "undefined") {
      try {
        const worker = new Worker(new URL("./encryption.worker.ts", import.meta.url), { type: "module" })
        this.worker = worker
        this.workerReady = new Promise((resolve) => {
          let settled = false
          const finish = (ready: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            this.cancelWorkerInitialization = undefined
            if (!ready) this.stopWorker(worker)
            resolve(ready)
          }
          this.cancelWorkerInitialization = () => finish(false)
          worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            if (event.data?.type !== "ready") {
              finish(false)
              return
            }
            worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleWorkerMessage(event.data)
            worker.onerror = (event) => {
              event.preventDefault()
              this.failWorker(new Error(event.message || "Encryption worker failed"))
            }
            worker.onmessageerror = () => {
              this.failWorker(new Error("Encryption worker returned an invalid message"))
            }
            finish(true)
          }
          worker.onerror = (event) => {
            event.preventDefault()
            finish(false)
          }
          worker.onmessageerror = () => finish(false)
          const timer = setTimeout(() => finish(false), cryptoWorkerInitializationTimeoutMs)
          try {
            worker.postMessage({ type: "initialize", key, header })
          } catch {
            finish(false)
          }
        })
      } catch {
        this.stopWorker()
      }
    }
  }

  encrypt(index: number, plaintext: ArrayBuffer): Promise<ArrayBuffer> {
    return this.transform("encrypt", index, plaintext)
  }

  decrypt(index: number, ciphertext: ArrayBuffer): Promise<ArrayBuffer> {
    return this.transform("decrypt", index, ciphertext)
  }

  close(): void {
    this.shutdown(new DOMException("Encryption session was closed", "AbortError"))
  }

  private async transform(type: "encrypt" | "decrypt", index: number, data: ArrayBuffer): Promise<ArrayBuffer> {
    if (this.closed) {
      throw this.terminalError ?? new DOMException("Encryption session was closed", "AbortError")
    }
    const workerReady = await this.workerReady
    if (this.closed) {
      throw this.terminalError ?? new DOMException("Encryption session was closed", "AbortError")
    }
    const worker = this.worker
    if (!workerReady || !worker) {
      return await (type === "encrypt"
        ? encryptChunk(this.key, this.header, index, data)
        : decryptChunk(this.key, this.header, index, data))
    }

    return this.requests.request(
      (id) => worker.postMessage({ type, id, index, data }, [data]),
      (error) => this.failWorker(asWorkerError(error, "Encryption worker request failed")),
    )
  }

  private handleWorkerMessage(result: WorkerResponse): void {
    if (result?.type !== "result") {
      this.failWorker(new Error("Encryption worker returned an invalid message"))
      return
    }
    if (result.data instanceof ArrayBuffer) this.requests.resolve(result.id, result.data)
    else this.requests.reject(result.id, new Error(result.error || "Encryption worker failed"))
  }

  private stopWorker(worker = this.worker): void {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    if (this.worker === worker) this.worker = undefined
  }

  private failWorker(error: Error): void {
    this.shutdown(error)
  }

  private shutdown(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.terminalError = error
    this.cancelWorkerInitialization?.()
    this.cancelWorkerInitialization = undefined
    this.stopWorker()
    this.requests.rejectAll(error)
  }
}

function verifyScheme(scheme: EncryptionScheme): void {
  if (scheme !== CHUNKED_ENCRYPTION_SCHEME) throw new Error(`Unsupported encryption scheme: ${scheme as string}`)
}

export async function genKey(scheme: EncryptionScheme): Promise<CryptoKey> {
  verifyScheme(scheme)
  return await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
}

export async function encodeKey(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key))
  return bytesToBase64Url(raw)
}

export async function decodeKey(scheme: EncryptionScheme, encoded: string): Promise<CryptoKey> {
  verifyScheme(scheme)
  let raw: Uint8Array
  try {
    raw = base64UrlToBytes(encoded)
  } catch {
    throw new Error("The AES-GCM key in the URL is not valid base64url")
  }
  if (raw.length !== 32) {
    throw new Error(`AES-GCM key must decode to 32 bytes (256-bit), got ${raw.length} bytes`)
  }
  return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", true, ["encrypt", "decrypt"])
}

export interface ChunkedEncryptionContext {
  key: CryptoKey
  encodedKey: string
  session: ChunkCryptoSession
}

export async function createChunkedEncryptionContext(plaintextSize: number): Promise<ChunkedEncryptionContext> {
  const key = await genKey(CHUNKED_ENCRYPTION_SCHEME)
  const header = createEncryptionHeader(plaintextSize)
  return {
    key,
    encodedKey: await encodeKey(key),
    session: new ChunkCryptoSession(key, header, plaintextSize >= cryptoWorkerThreshold),
  }
}

export function createChunkedDecryptionSession(key: CryptoKey, headerBytes: Uint8Array): ChunkCryptoSession {
  const header = parseEncryptionHeader(headerBytes)
  return new ChunkCryptoSession(key, header, header.plaintextSize >= cryptoWorkerThreshold)
}

export async function encrypt(scheme: EncryptionScheme, key: CryptoKey, msg: Uint8Array): Promise<Uint8Array> {
  verifyScheme(scheme)
  const header = createEncryptionHeader(msg.byteLength)
  const output = new Uint8Array(encryptedFileSize(msg.byteLength))
  output.set(header.bytes, 0)
  let outputOffset = ENCRYPTION_HEADER_SIZE
  for (let index = 0; index < encryptionChunkCount(msg.byteLength); index += 1) {
    const { start, end } = encryptionChunkBounds(msg.byteLength, index)
    const encrypted = new Uint8Array(
      await encryptChunk(key, header, index, msg.subarray(start, end) as Uint8Array<ArrayBuffer>),
    )
    output.set(encrypted, outputOffset)
    outputOffset += encrypted.byteLength
  }
  return output
}

export async function decrypt(
  scheme: EncryptionScheme,
  key: CryptoKey,
  ciphertext: Uint8Array,
): Promise<Uint8Array | null> {
  verifyScheme(scheme)
  if (ciphertext.byteLength < ENCRYPTION_HEADER_SIZE + ENCRYPTION_TAG_SIZE) return null

  try {
    const header = parseEncryptionHeader(ciphertext.subarray(0, ENCRYPTION_HEADER_SIZE))
    if (ciphertext.byteLength !== encryptedFileSize(header.plaintextSize)) return null
    const plaintext = new Uint8Array(header.plaintextSize)
    let inputOffset = ENCRYPTION_HEADER_SIZE
    for (let index = 0; index < encryptionChunkCount(header.plaintextSize); index += 1) {
      const { start, end } = encryptionChunkBounds(header.plaintextSize, index)
      const encryptedLength = end - start + ENCRYPTION_TAG_SIZE
      const encrypted = ciphertext.subarray(inputOffset, inputOffset + encryptedLength) as Uint8Array<ArrayBuffer>
      const decrypted = new Uint8Array(await decryptChunk(key, header, index, encrypted))
      plaintext.set(decrypted, start)
      inputOffset += encryptedLength
    }
    return plaintext
  } catch {
    return null
  }
}
