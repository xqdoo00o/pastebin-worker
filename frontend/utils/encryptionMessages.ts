import type { ChunkedEncryptionHeader } from "./encryptionCore.js"

export type EncryptionWorkerRequest =
  | { type: "initialize"; key: CryptoKey; header: ChunkedEncryptionHeader }
  | { type: "encrypt" | "decrypt"; id: number; index: number; data: ArrayBuffer }

export type EncryptionWorkerResponse =
  | { type: "ready" }
  | { type: "result"; id: number; data: ArrayBuffer; error?: never }
  | { type: "result"; id: number; error: string; data?: never }
