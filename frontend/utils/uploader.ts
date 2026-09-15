import type { PasteEditState } from "../models/paste.js"
import type { PasteSetting } from "./pasteSetting.js"
import { verifyFileSize } from "./utils.js"
import { ErrorWithTitle, isFileReadError } from "./errors.js"
import { readFileSlice } from "./byteSource.js"
import type { PasteResponse, PublicEnv } from "../../shared/interfaces.js"
import { CHUNKED_ENCRYPTION_SCHEME, createChunkedEncryptionContext } from "./encryption.js"
import { encryptedFileSize, encryptionChunkBounds, encryptionChunkCount } from "./encryptionCore.js"
import type { UploadOptions } from "../../shared/uploadPaste.js"
import { UploadError, uploadMPU, uploadMPUSource, uploadNormal } from "../../shared/uploadPaste.js"
import { DIRECT_UPLOAD_MAX_BYTES } from "../../shared/constants.js"
import { inferHighlightLanguage } from "../../shared/fileType.js"
import { parseReadLimit } from "../../shared/verify.js"
import { prepareContent } from "./content.js"

const ENCRYPTED_MPU_CONCURRENCY = 4

export interface UploadProgress {
  doneBytes: number
  totalBytes: number
}

export async function uploadPaste(
  pasteSetting: PasteSetting,
  editorState: PasteEditState,
  onEncryptionKeyChange: (k: string | undefined) => void, // we only generate key on upload, so need a callback of key generation
  config: PublicEnv,
  onProgress?: (progress: UploadProgress | undefined) => void,
  signal?: AbortSignal,
): Promise<PasteResponse> {
  const prepared = await prepareContent(editorState, {
    errorTitle: "Error on Preparing Upload",
    archiveCompression: pasteSetting.archiveCompression,
    compressSingleFile: pasteSetting.compressSingleFile,
    signal,
  })
  const { content, originalFiles } = prepared

  try {
    const storedSize = pasteSetting.doEncrypt ? encryptedFileSize(content.size) : content.size
    const [contentSizeOk, contentSizeMsg] = verifyFileSize(storedSize, config)
    if (!contentSizeOk) {
      throw new ErrorWithTitle("Error on Preparing Upload", contentSizeMsg)
    }
    const readLimit = parseReadLimit(pasteSetting.readLimit)
    if (readLimit === null) {
      throw new ErrorWithTitle("Error on Preparing Upload", "Reads must be a non-negative integer")
    }

    const options: UploadOptions = {
      content,
      filenames: originalFiles,
      isUpdate: pasteSetting.uploadKind === "manage",
      isPrivate: pasteSetting.uploadKind === "long",
      expire: pasteSetting.expiration,
      remainingReads: readLimit,
      highlightLanguage:
        editorState.editKind === "edit" ? editorState.editHighlightLang : inferHighlightLanguage(content.name),
      encryptionScheme: pasteSetting.doEncrypt ? CHUNKED_ENCRYPTION_SCHEME : undefined,
      inferMimeType: editorState.editKind === "file",
      manageUrl: pasteSetting.manageUrl,
    }

    const contentLength = storedSize
    const reportProgress = (doneBytes: number, totalBytes: number) => {
      if (onProgress) onProgress({ doneBytes, totalBytes })
    }

    try {
      if (onProgress) onProgress({ doneBytes: 0, totalBytes: contentLength })
      if (!pasteSetting.doEncrypt) {
        onEncryptionKeyChange(undefined)
        if (contentLength <= DIRECT_UPLOAD_MAX_BYTES) {
          return await uploadNormal(config.DEPLOY_URL, options, reportProgress, signal)
        }
        return await uploadMPU(config.DEPLOY_URL, DIRECT_UPLOAD_MAX_BYTES, options, reportProgress, undefined, signal)
      }

      const context = await createChunkedEncryptionContext(content.size)
      onEncryptionKeyChange(context.encodedKey)
      const encryptionPartCount = encryptionChunkCount(content.size)
      const encryptedPart = async (index: number, abortSignal?: AbortSignal): Promise<Blob> => {
        abortSignal?.throwIfAborted()
        const { start, end } = encryptionChunkBounds(content.size, index)
        const plaintext = (await readFileSlice(content, start, end, abortSignal)).buffer
        const ciphertext = await context.session.encrypt(index, plaintext)
        abortSignal?.throwIfAborted()
        return index === 0 ? new Blob([context.session.header.bytes, ciphertext]) : new Blob([ciphertext])
      }

      try {
        if (storedSize <= DIRECT_UPLOAD_MAX_BYTES) {
          const encryptedContent = new File([await encryptedPart(0, signal)], content.name)
          return await uploadNormal(
            config.DEPLOY_URL,
            { ...options, content: encryptedContent },
            reportProgress,
            signal,
          )
        }

        return await uploadMPUSource(
          config.DEPLOY_URL,
          {
            name: content.name,
            size: storedSize,
            partCount: encryptionPartCount,
            getPart: encryptedPart,
          },
          options,
          reportProgress,
          ENCRYPTED_MPU_CONCURRENCY,
          signal,
        )
      } finally {
        context.session.close()
      }
    } catch (e) {
      if (isFileReadError(e)) {
        throw new ErrorWithTitle("Error on Preparing Upload", e.message)
      }
      if (e instanceof UploadError) {
        throw new ErrorWithTitle("Error on Upload", e.message)
      }
      throw e
    } finally {
      if (onProgress) onProgress(undefined)
    }
  } finally {
    await prepared.cleanup?.()
  }
}
