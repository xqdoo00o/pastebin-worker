import type { ChunkedEncryptionHeader } from "./encryptionCore.js"
import { decryptChunk, encryptChunk } from "./encryptionCore.js"
import { errorMessage } from "./errors.js"

import type { EncryptionWorkerRequest, EncryptionWorkerResponse } from "./encryptionMessages.js"

let key: CryptoKey | undefined
let header: ChunkedEncryptionHeader | undefined

self.onmessage = (event: MessageEvent<EncryptionWorkerRequest>) => {
  const message = event.data
  if (message.type === "initialize") {
    key = message.key
    header = message.header
    self.postMessage({ type: "ready" } satisfies EncryptionWorkerResponse)
    return
  }

  void (async () => {
    try {
      if (!key || !header) throw new Error("Encryption worker is not initialized")
      const data =
        message.type === "encrypt"
          ? await encryptChunk(key, header, message.index, message.data)
          : await decryptChunk(key, header, message.index, message.data)
      const response: EncryptionWorkerResponse = { type: "result", id: message.id, data }
      self.postMessage(response, { transfer: [data] })
    } catch (error) {
      const response: EncryptionWorkerResponse = {
        type: "result",
        id: message.id,
        error: errorMessage(error),
      }
      self.postMessage(response)
    }
  })()
}
