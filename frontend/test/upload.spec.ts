import { readFileSync } from "node:fs"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { PasteEditState } from "../models/paste.js"
import type { PasteSetting } from "../utils/pasteSetting.js"
import type { PasteResponse, PublicEnv } from "../../shared/interfaces.js"
import type { MPUUploadSource, UploadOptions } from "../../shared/uploadPaste.js"
import {
  DEFAULT_EDIT_FILENAME,
  DIRECT_UPLOAD_MAX_BYTES,
  TEXT_MIME_TYPE,
  ZIP_MEMORY_THRESHOLD_BYTES,
} from "../../shared/constants.js"
import { estimateArchiveSize, zipFiles } from "../utils/archive.js"
import {
  streamZipFiles,
  ZstdCompressionStream,
  type ArchiveWorkerRequest,
  type ArchiveWorkerResponse,
} from "../utils/archiveCore.js"
import { prepareContent } from "../utils/content.js"
import { decodeKey, decrypt } from "../utils/encryption.js"
import { isSameEditorState } from "../utils/content.js"
import {
  CHUNKED_ENCRYPTION_SCHEME,
  ENCRYPTION_HEADER_SIZE,
  ENCRYPTION_PART_SIZE,
  ENCRYPTION_TAG_SIZE,
  firstEncryptionPlaintextSize,
  followingEncryptionPlaintextSize,
} from "../utils/encryptionCore.js"
import { defaultOpticalTransferSettings, normalizeTransferMethod, validatePasteSetting } from "../utils/pasteSetting.js"
import { decompressZstd, initializeZstdDecoder, initializeZstdEncoder } from "../wasm/zstd-runtime.js"

async function buildTestZip(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  const writer = new Uint8ArrayWriter()
  const zipWriter = new ZipWriter(writer)
  for (const [name, data] of Object.entries(entries)) {
    await zipWriter.add(name, new Uint8ArrayReader(data))
  }
  await zipWriter.close()
  return writer.getData()
}

async function readTestZipEntries(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes))
  const entries = await reader.getEntries()
  const out: Record<string, Uint8Array> = {}
  for (const entry of entries) {
    // Directory entries (e.g. empty folders named with a trailing slash) carry
    // no data; treat them as a zero-length entry for comparison.
    out[entry.filename] = entry.directory ? new Uint8Array(0) : await entry.getData(new Uint8ArrayWriter())
  }
  await reader.close()
  return out
}

const uploadMocks = vi.hoisted(() => ({
  uploadNormal: vi.fn(),
  uploadMPU: vi.fn(),
  uploadMPUSource: vi.fn(),
}))

vi.mock("../../shared/uploadPaste.js", () => ({
  UploadError: class UploadError extends Error {},
  uploadNormal: uploadMocks.uploadNormal,
  uploadMPU: uploadMocks.uploadMPU,
  uploadMPUSource: uploadMocks.uploadMPUSource,
}))

import { uploadPaste } from "../utils/uploader.js"

function mockOPFS(onWrite?: () => void, retainWrites = true) {
  const storedParts: BlobPart[] = []
  const write = vi.fn((data: FileSystemWriteChunkType) => {
    if (retainWrites) storedParts.push(data as unknown as BlobPart)
    onWrite?.()
    return Promise.resolve()
  })
  const close = vi.fn(() => Promise.resolve())
  const abort = vi.fn(() => Promise.resolve())
  const removeEntry = vi.fn(() => Promise.resolve())
  const getFileHandle = vi.fn((_name: string) =>
    Promise.resolve({
      createWritable: () => Promise.resolve({ write, close, abort }),
      getFile: () => Promise.resolve(new File(storedParts, "temporary.zip")),
    }),
  )
  const root = {
    async *entries() {
      await Promise.resolve()
      yield ["unrelated", { kind: "directory" } as FileSystemDirectoryHandle]
    },
    removeEntry,
    getFileHandle,
  } as unknown as FileSystemDirectoryHandle
  const getDirectory = vi.fn(() => Promise.resolve(root))
  vi.stubGlobal("navigator", {
    storage: {
      estimate: () => Promise.resolve({ quota: 512 * 1024 * 1024, usage: 0 }),
      getDirectory,
    },
  })
  return { abort, close, getDirectory, getFileHandle, removeEntry, write }
}

const config = {
  DEPLOY_URL: "https://example.com",
  R2_MAX_ALLOWED: "10M",
  DEFAULT_READS: 0,
} as Env

const pasteSetting: PasteSetting = {
  uploadKind: "short",
  transferMethod: "upload",
  archiveCompression: "deflate",
  expiration: "",
  readLimit: "0",
  manageUrl: "",
  doEncrypt: false,
  verifyP2P: false,
  optical: defaultOpticalTransferSettings(),
}

const validationConfig = {
  ...config,
  MAX_EXPIRATION: "1d",
  MAX_P2P_EXPIRATION: "1h",
} as PublicEnv

const validationSetting: PasteSetting = {
  ...pasteSetting,
  expiration: "1h",
}

function uploadResponse(): PasteResponse {
  return {
    url: "https://example.com/abcd",
    manageUrl: "https://example.com/abcd:pw",
    expirationSeconds: 300,
    lastModifiedAt: "2025-04-30T23:55:00.000Z",
    createdAt: "2025-04-30T23:55:00.000Z",
    expireAt: "2025-05-01T00:00:00.000Z",
    sizeBytes: 1,
    location: "KV",
  }
}

function fileEditorState(files: File[]): PasteEditState {
  return {
    editKind: "file",
    editContent: "",
    files,
  }
}

function fileThatBecomesUnreadable(content: BlobPart, name: string): File {
  const file = new File([content], name)
  const originalSlice = file.slice.bind(file)
  let reads = 0
  vi.spyOn(file, "slice").mockImplementation((start, end, contentType) => {
    if (reads++ === 0) return originalSlice(start, end, contentType)
    return {
      arrayBuffer: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
    } as Blob
  })
  return file
}

function textEditorState(content: string, filename?: string): PasteEditState {
  return {
    editKind: "edit",
    editContent: content,
    editFilename: filename,
    files: [],
    editHighlightLang: "plaintext",
  }
}

function firstUploadOptions(): UploadOptions {
  const calls = uploadMocks.uploadNormal.mock.calls as unknown as [string, UploadOptions][]
  return calls[0][1]
}

/** Runs the archive worker protocol in-process because jsdom has no Worker implementation. */
class InProcessArchiveWorker {
  onmessage: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  private nextChunkId = 1
  private pendingAck: (() => void) | undefined
  private terminated = false

  postMessage(message: ArchiveWorkerRequest): void {
    if (message.type === "chunk-ack") {
      const resolve = this.pendingAck
      this.pendingAck = undefined
      resolve?.()
      return
    }
    if (message.type === "init") {
      if (message.zstdEncoderWasmModule) void initializeZstdEncoder(message.zstdEncoderWasmModule)
      return
    }

    void (async () => {
      try {
        await streamZipFiles(
          message.files,
          (chunk) => {
            if (this.terminated) throw new Error("Archive worker terminated")
            const id = this.nextChunkId++
            const data = chunk.slice().buffer
            return new Promise<void>((resolve) => {
              this.pendingAck = resolve
              const response: ArchiveWorkerResponse = { type: "chunk", id, data }
              queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>))
            })
          },
          { compression: message.compression },
        )
        if (!this.terminated) {
          const response: ArchiveWorkerResponse = { type: "complete" }
          queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>))
        }
      } catch (error) {
        if (this.terminated) return
        const response: ArchiveWorkerResponse = {
          type: "error",
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        }
        queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>))
      }
    })()
  }

  terminate(): void {
    this.terminated = true
    const resolve = this.pendingAck
    this.pendingAck = undefined
    resolve?.()
  }
}

function useInProcessArchiveWorker(): void {
  vi.stubGlobal("Worker", InProcessArchiveWorker)
}

describe("validatePasteSetting", () => {
  it("does not validate hidden manage-URL field", () => {
    const validation = validatePasteSetting(validationSetting, validationConfig)

    expect(validation.manageUrl[0]).toBe(true)
    expect(validation.isValid).toBe(true)
  })

  it("validates the field selected by the URL kind", () => {
    expect(validatePasteSetting({ ...validationSetting, uploadKind: "manage" }, validationConfig).manageUrl[0]).toBe(
      false,
    )
    expect(
      validatePasteSetting(
        { ...validationSetting, uploadKind: "manage", manageUrl: "https://example.com/paste:password" },
        validationConfig,
      ).isValid,
    ).toBe(true)
  })

  it("uses P2P expiration and transfer validation while ignoring upload-only fields", () => {
    const validation = validatePasteSetting(
      {
        ...validationSetting,
        transferMethod: "p2p",
        expiration: "30m",
        readLimit: "2",
        uploadKind: "manage",
      },
      validationConfig,
    )

    expect(validation.isValid).toBe(true)
    expect(
      validatePasteSetting({ ...validationSetting, transferMethod: "p2p", readLimit: "-1" }, validationConfig).isValid,
    ).toBe(false)
  })

  it("ignores upload and P2P-only fields for QR camera transfer", () => {
    const validation = validatePasteSetting(
      {
        ...validationSetting,
        transferMethod: "optical",
        expiration: "invalid",
        readLimit: "invalid",
        uploadKind: "manage",
      },
      validationConfig,
    )

    expect(validation.isValid).toBe(true)
  })
})

describe("normalizeTransferMethod", () => {
  it.each([
    ["upload", "upload"],
    ["p2p", "p2p"],
    ["optical", "optical"],
  ] as const)("maps Wrangler method %s to %s", (configured, method) => {
    expect(normalizeTransferMethod(configured)).toBe(method)
  })

  it("falls back to upload for an invalid Wrangler value", () => {
    expect(normalizeTransferMethod("unknown")).toBe("upload")
  })
})

describe("defaultOpticalTransferSettings", () => {
  it("normalizes valid Wrangler QR defaults", () => {
    expect(
      defaultOpticalTransferSettings({
        DEFAULT_QR_TX_FPS: 24,
        DEFAULT_QR_FRAME_BYTES: 1465,
        DEFAULT_QR_ECC: "q",
        DEFAULT_QR_LAYOUT: 4,
      }),
    ).toStrictEqual({ txFps: 24, frameBytes: 1465, ecc: "Q", gridCodes: 4 })
  })

  it("falls back when Wrangler QR defaults are unsupported", () => {
    expect(
      defaultOpticalTransferSettings({
        DEFAULT_QR_TX_FPS: 59,
        DEFAULT_QR_FRAME_BYTES: 42,
        DEFAULT_QR_ECC: "invalid",
        DEFAULT_QR_LAYOUT: 3,
      }),
    ).toStrictEqual({ txFps: 60, frameBytes: 2953, ecc: "L", gridCodes: 1 })
  })

  it("normalizes a Wrangler frame size that the selected ECC cannot encode", () => {
    expect(defaultOpticalTransferSettings({ DEFAULT_QR_FRAME_BYTES: 2953, DEFAULT_QR_ECC: "H" })).toMatchObject({
      frameBytes: 1000,
      ecc: "H",
    })
  })
})

describe("uploadPaste", () => {
  beforeEach(() => {
    uploadMocks.uploadNormal.mockReset()
    uploadMocks.uploadMPU.mockReset()
    uploadMocks.uploadMPUSource.mockReset()
    uploadMocks.uploadNormal.mockResolvedValue(uploadResponse())
    uploadMocks.uploadMPUSource.mockResolvedValue(uploadResponse())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("zips a single file with a relative path and keeps filenames metadata", async () => {
    useInProcessArchiveWorker()
    const file = new File([new TextEncoder().encode("Hello")], "normal-folder/file.txt")

    await uploadPaste(pasteSetting, fileEditorState([file]), vi.fn(), config)

    expect(uploadMocks.uploadNormal).toHaveBeenCalledTimes(1)
    const options = firstUploadOptions()
    expect(options.inferMimeType).toStrictEqual(true)
    expect(options.filenames).toStrictEqual([{ name: "normal-folder/file.txt", sizeBytes: 5 }])
    expect(options.content).toBeInstanceOf(File)
    expect(options.content.name).toMatch(/^1-item-\d{4}-\d{2}-\d{2}\.zip$/)

    const unzipped = await readTestZipEntries(new Uint8Array(await options.content.arrayBuffer()))
    expect(new TextDecoder().decode(unzipped["normal-folder/file.txt"])).toStrictEqual("Hello")
  })

  it("optionally zips a single ordinary file using the selected archive compression", async () => {
    useInProcessArchiveWorker()
    const file = new File([new TextEncoder().encode("Hello")], "notes.txt", { type: "text/plain" })

    await uploadPaste(
      { ...pasteSetting, compressSingleFile: true, archiveCompression: "deflate" },
      fileEditorState([file]),
      vi.fn(),
      config,
    )

    const options = firstUploadOptions()
    expect(options.filenames).toStrictEqual([{ name: "notes.txt", sizeBytes: 5 }])
    expect(options.content.name).toMatch(/^1-item-\d{4}-\d{2}-\d{2}\.zip$/)
    const unzipped = await readTestZipEntries(new Uint8Array(await options.content.arrayBuffer()))
    expect(new TextDecoder().decode(unzipped["notes.txt"])).toStrictEqual("Hello")
  })

  it("removes an OPFS-backed archive after upload completes", async () => {
    useInProcessArchiveWorker()
    const opfs = mockOPFS(undefined, false)
    const largeFile = {
      name: "folder/large.jpg",
      size: ZIP_MEMORY_THRESHOLD_BYTES,
      type: "image/jpeg",
      // Match File.slice()'s requested length. zip.js 2.11.2 correctly advances
      // custom Readers by the bytes actually returned instead of skipping the
      // unread remainder of a short chunk.
      slice: (start = 0, end = ZIP_MEMORY_THRESHOLD_BYTES) =>
        new Blob([new Uint8Array(Math.max(0, Math.min(end, ZIP_MEMORY_THRESHOLD_BYTES) - start))]),
    } as File

    await uploadPaste(pasteSetting, fileEditorState([largeFile]), vi.fn(), config)

    expect(opfs.write).toHaveBeenCalled()
    expect(opfs.close).toHaveBeenCalledTimes(1)
    expect(opfs.abort).not.toHaveBeenCalled()
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1)
  })

  it("stores empty folders as zero-byte trailing-slash zip entries", async () => {
    useInProcessArchiveWorker()
    const emptyFolder = new File([new Uint8Array(0)], "parent-dir/sub-dir/another-empty/")

    await uploadPaste(pasteSetting, fileEditorState([emptyFolder]), vi.fn(), config)

    const options = firstUploadOptions()
    expect(options.filenames).toStrictEqual([{ name: "parent-dir/sub-dir/another-empty/", sizeBytes: 0 }])

    const unzipped = await readTestZipEntries(new Uint8Array(await options.content.arrayBuffer()))
    expect(unzipped["parent-dir/sub-dir/another-empty/"]).toHaveLength(0)
  })

  it("stores already-compressed files without running DEFLATE again", async () => {
    useInProcessArchiveWorker()
    const image = new File([new Uint8Array([1, 2, 3, 4])], "photos/image.jpg", { type: "image/jpeg" })

    await uploadPaste(pasteSetting, fileEditorState([image]), vi.fn(), config)

    const zipBytes = new Uint8Array(await firstUploadOptions().content.arrayBuffer())
    expect(new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength).getUint16(8, true)).toStrictEqual(0)
    const unzipped = await readTestZipEntries(zipBytes)
    expect(Array.from(unzipped["photos/image.jpg"])).toStrictEqual([1, 2, 3, 4])
  })

  it("does not infer mimeType for edit tab uploads", async () => {
    await uploadPaste(pasteSetting, textEditorState("hello"), vi.fn(), config)

    const options = firstUploadOptions()
    expect(options.inferMimeType).toStrictEqual(false)
  })

  it("infers highlight language for a single code file upload", async () => {
    await uploadPaste(
      pasteSetting,
      fileEditorState([new File(["const answer = 42"], "answer.js", { type: "text/javascript" })]),
      vi.fn(),
      config,
    )

    expect(firstUploadOptions().highlightLanguage).toBe("javascript")
  })

  it("cancels archive preparation before starting an upload", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      uploadPaste(
        pasteSetting,
        fileEditorState([new File(["one"], "one.txt"), new File(["two"], "two.txt")]),
        vi.fn(),
        config,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(uploadMocks.uploadNormal).not.toHaveBeenCalled()
  })

  it("passes the current reads setting, including unlimited reads", async () => {
    await uploadPaste({ ...pasteSetting, readLimit: "0" }, textEditorState("hello"), vi.fn(), config)

    expect(firstUploadOptions().remainingReads).toStrictEqual(0)
  })

  it("encrypts a small paste in the chunked container before normal upload", async () => {
    let encodedKey: string | undefined
    await uploadPaste(
      { ...pasteSetting, doEncrypt: true },
      textEditorState("encrypted hello"),
      (key) => (encodedKey = key),
      config,
    )

    const options = firstUploadOptions()
    expect(options.encryptionScheme).toStrictEqual(CHUNKED_ENCRYPTION_SCHEME)
    const key = await decodeKey(CHUNKED_ENCRYPTION_SCHEME, encodedKey!)
    const decrypted = await decrypt(CHUNKED_ENCRYPTION_SCHEME, key, new Uint8Array(await options.content.arrayBuffer()))
    expect(new TextDecoder().decode(decrypted!)).toStrictEqual("encrypted hello")
  })

  it("reports a file deleted while chunked encryption is reading it", async () => {
    const file = fileThatBecomesUnreadable("encrypted hello", "deleted-during-encryption.txt")

    await expect(
      uploadPaste({ ...pasteSetting, doEncrypt: true }, fileEditorState([file]), vi.fn(), config),
    ).rejects.toMatchObject({
      title: "Error on Preparing Upload",
      message:
        'Could not read "deleted-during-encryption.txt". It may have been moved, deleted, or changed since it was ' +
        "selected. Select the file again and retry.",
    })
    expect(uploadMocks.uploadNormal).not.toHaveBeenCalled()
  })

  it("uses MPU when encryption overhead pushes a single plaintext chunk over the direct-upload limit", async () => {
    const plaintextSize = DIRECT_UPLOAD_MAX_BYTES - ENCRYPTION_HEADER_SIZE - ENCRYPTION_TAG_SIZE + 1
    const file = new File([new Uint8Array(plaintextSize)], "boundary.bin")

    await uploadPaste({ ...pasteSetting, doEncrypt: true }, fileEditorState([file]), vi.fn(), config)

    expect(uploadMocks.uploadNormal).not.toHaveBeenCalled()
    expect(uploadMocks.uploadMPUSource).toHaveBeenCalledTimes(1)
    expect(uploadMocks.uploadMPUSource.mock.calls[0][4]).toBe(4)
    const source = uploadMocks.uploadMPUSource.mock.calls[0][1] as MPUUploadSource
    expect(source.size).toStrictEqual(DIRECT_UPLOAD_MAX_BYTES + ENCRYPTION_TAG_SIZE + 1)
    expect(source.partCount).toStrictEqual(2)
  })

  it("aligns independently encrypted chunks with MPU parts", async () => {
    const plaintextSize = firstEncryptionPlaintextSize() + followingEncryptionPlaintextSize() * 2 + 1
    const file = new File([new Uint8Array(plaintextSize)], "large.bin")
    const slice = vi.spyOn(file, "slice")
    let encodedKey: string | undefined
    const uploadedParts: Blob[] = []
    uploadMocks.uploadMPUSource.mockImplementation(async (_apiUrl, source: MPUUploadSource) => {
      const signal = new AbortController().signal
      uploadedParts.push(
        ...(await Promise.all(Array.from({ length: source.partCount }, (_, index) => source.getPart(index, signal)))),
      )
      return uploadResponse()
    })

    await uploadPaste({ ...pasteSetting, doEncrypt: true }, fileEditorState([file]), (key) => (encodedKey = key), {
      ...config,
      R2_MAX_ALLOWED: "20M",
    })

    expect(uploadMocks.uploadNormal).not.toHaveBeenCalled()
    expect(uploadMocks.uploadMPUSource).toHaveBeenCalledTimes(1)
    const source = uploadMocks.uploadMPUSource.mock.calls[0][1] as MPUUploadSource
    expect(source.partCount).toStrictEqual(4)
    expect(slice).toHaveBeenCalledTimes(5)
    expect(slice).toHaveBeenNthCalledWith(1, 0, 1)
    expect(uploadedParts.map((part) => part.size)).toStrictEqual([
      ENCRYPTION_PART_SIZE,
      ENCRYPTION_PART_SIZE,
      ENCRYPTION_PART_SIZE,
      ENCRYPTION_TAG_SIZE + 1,
    ])

    const key = await decodeKey(CHUNKED_ENCRYPTION_SCHEME, encodedKey!)
    const encrypted = new Uint8Array(await new Blob(uploadedParts).arrayBuffer())
    const decrypted = await decrypt(CHUNKED_ENCRYPTION_SCHEME, key, encrypted)
    expect(decrypted?.byteLength).toStrictEqual(plaintextSize)
  })
})

describe("prepareContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("treats a highlight-only text edit as a P2P metadata change", () => {
    const original = textEditorState("const answer = 42")

    expect(isSameEditorState(original, { ...original, editHighlightLang: "typescript" })).toBe(false)
  })

  it("creates a UTF-8 text file with the configured or default filename", async () => {
    const named = await prepareContent(textEditorState("hello", "note.txt"))
    const unnamed = await prepareContent(textEditorState("hello"))

    expect(named.content.name).toStrictEqual("note.txt")
    expect(named.content.type).toStrictEqual(TEXT_MIME_TYPE.toLowerCase())
    expect(await named.content.text()).toStrictEqual("hello")
    expect(named.originalFiles).toBeUndefined()
    expect(unnamed.content.name).toStrictEqual(DEFAULT_EDIT_FILENAME)
  })

  it("returns a single flat file without copying or archive metadata", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" })

    const prepared = await prepareContent(fileEditorState([file]))

    expect(prepared.content).toBe(file)
    expect(prepared.originalFiles).toBeUndefined()
  })

  it("reports a selected file that is no longer readable with the caller's title", async () => {
    const file = new File(["hello"], "deleted.txt", { type: "text/plain" })
    vi.spyOn(file, "slice").mockReturnValue({
      arrayBuffer: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
    } as Blob)

    await expect(
      prepareContent(fileEditorState([file]), { errorTitle: "Error on Preparing QR Camera Share" }),
    ).rejects.toMatchObject({
      title: "Error on Preparing QR Camera Share",
      message:
        'Could not read "deleted.txt". It may have been moved, deleted, or changed since it was selected. ' +
        "Select the file again and retry.",
    })
  })

  it("reports a file deleted while streaming it into a compressed archive", async () => {
    useInProcessArchiveWorker()
    const file = fileThatBecomesUnreadable("hello", "deleted-during-compression.txt")

    await expect(
      prepareContent(fileEditorState([file]), {
        errorTitle: "Error on Preparing Upload",
        compressSingleFile: true,
      }),
    ).rejects.toMatchObject({
      title: "Error on Preparing Upload",
      message:
        'Could not read "deleted-during-compression.txt". It may have been moved, deleted, or changed since it was ' +
        "selected. Select the file again and retry.",
    })
  })

  it("zips multiple files and returns their original metadata", async () => {
    useInProcessArchiveWorker()
    const files = [new File(["one"], "one.txt"), new File(["two"], "folder/two.txt")]

    const prepared = await prepareContent(fileEditorState(files))

    expect(prepared.originalFiles).toStrictEqual([
      { name: "one.txt", sizeBytes: 3 },
      { name: "folder/two.txt", sizeBytes: 3 },
    ])
    expect(prepared.content.type).toStrictEqual("application/zip")
    const archive = await readTestZipEntries(new Uint8Array(await prepared.content.arrayBuffer()))
    expect(new TextDecoder().decode(archive["one.txt"])).toStrictEqual("one")
    expect(new TextDecoder().decode(archive["folder/two.txt"])).toStrictEqual("two")
  })

  it("zips a single text edit when compressSingleFile is enabled", async () => {
    useInProcessArchiveWorker()
    const prepared = await prepareContent(textEditorState("hello", "note.txt"), {
      compressSingleFile: true,
      archiveCompression: "deflate",
    })

    expect(prepared.originalFiles).toStrictEqual([{ name: "note.txt", sizeBytes: 5 }])
    expect(prepared.content.type).toStrictEqual("application/zip")
    const archive = await readTestZipEntries(new Uint8Array(await prepared.content.arrayBuffer()))
    expect(new TextDecoder().decode(archive["note.txt"])).toStrictEqual("hello")
  })

  it("uses the caller's preparation title for validation errors", async () => {
    await expect(
      prepareContent(textEditorState(""), { errorTitle: "Error on Preparing P2P Share" }),
    ).rejects.toMatchObject({
      title: "Error on Preparing P2P Share",
      message: "Empty paste",
    })
    await expect(
      prepareContent(fileEditorState([]), { errorTitle: "Error on Preparing Upload" }),
    ).rejects.toMatchObject({
      title: "Error on Preparing Upload",
      message: "No file selected",
    })
  })

  it("honors cancellation before preparing content", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(prepareContent(textEditorState("hello"), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
  })
})

describe("ZIP archive storage", () => {
  beforeAll(async () => {
    await Promise.all([
      initializeZstdEncoder(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm")),
      initializeZstdDecoder(readFileSync("frontend/wasm/zstd/zstd_decoder_simd.wasm")),
    ])
  })

  const files = [new File(["one"], "one.txt"), new File(["two"], "folder/two.txt")]

  beforeEach(() => {
    useInProcessArchiveWorker()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps archives below the threshold in memory", async () => {
    const archive = await zipFiles(files, { opfsThreshold: Number.MAX_SAFE_INTEGER })

    expect(archive.cleanup).toBeUndefined()
    const entries = await readTestZipEntries(new Uint8Array(await archive.file.arrayBuffer()))
    expect(new TextDecoder().decode(entries["one.txt"])).toStrictEqual("one")
    expect(new TextDecoder().decode(entries["folder/two.txt"])).toStrictEqual("two")
  })

  it("uses one archive worker for every file in the ZIP", async () => {
    const instances: MockArchiveWorker[] = []

    class MockArchiveWorker {
      onmessage: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      onmessageerror: (() => void) | null = null
      readonly terminate = vi.fn()
      readonly startRequests: File[][] = []

      constructor() {
        instances.push(this)
      }

      postMessage(message: ArchiveWorkerRequest): void {
        if (message.type === "chunk-ack") {
          const response: ArchiveWorkerResponse = { type: "complete" }
          queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>))
          return
        }
        if (message.type === "init") return

        this.startRequests.push(message.files)
        void (async () => {
          const entries: Record<string, Uint8Array> = {}
          for (const file of message.files) entries[file.name] = new Uint8Array(await file.arrayBuffer())
          const archive = await buildTestZip(entries)
          const data = archive.slice().buffer
          const response: ArchiveWorkerResponse = { type: "chunk", id: 1, data }
          queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>))
        })()
      }
    }

    vi.stubGlobal("Worker", MockArchiveWorker)
    const workerFiles = Array.from({ length: 5 }, (_, index) => new File([`file-${index}`], `file-${index}.txt`))
    const archive = await zipFiles(workerFiles, { opfsThreshold: Number.MAX_SAFE_INTEGER })

    expect(instances).toHaveLength(1)
    expect(instances[0].startRequests).toHaveLength(1)
    expect(instances[0].startRequests[0]).toStrictEqual(workerFiles)
    expect(instances[0].terminate).toHaveBeenCalledTimes(1)
    const entries = await readTestZipEntries(new Uint8Array(await archive.file.arrayBuffer()))
    expect(Object.keys(entries)).toStrictEqual(workerFiles.map((file) => file.name))
  })

  it("asks the archive worker to use its fflate codec worker when native compression is unavailable", async () => {
    const startRequests: Extract<ArchiveWorkerRequest, { type: "start" }>[] = []

    class CapturingArchiveWorker {
      onmessage: ((event: MessageEvent<ArchiveWorkerResponse>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      onmessageerror: (() => void) | null = null
      readonly terminate = vi.fn()

      postMessage(message: ArchiveWorkerRequest): void {
        if (message.type !== "start") return
        startRequests.push(message)
        const response: ArchiveWorkerResponse = { type: "complete" }
        queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<ArchiveWorkerResponse>))
      }
    }

    vi.stubGlobal(
      "CompressionStream",
      class UnsupportedCompressionStream {
        constructor() {
          throw new TypeError("CompressionStream is unavailable")
        }
      },
    )
    vi.stubGlobal("Worker", CapturingArchiveWorker)

    await zipFiles([new File(["compress me"], "fallback.txt")], { opfsThreshold: Number.MAX_SAFE_INTEGER })

    expect(startRequests).toHaveLength(1)
    expect(startRequests[0].useFflateWorker).toBe(true)
  })

  it("streams archives above the threshold into OPFS and exposes cleanup", async () => {
    const opfs = mockOPFS()
    const archive = await zipFiles(files, { opfsThreshold: 1 })

    expect(opfs.getDirectory).toHaveBeenCalledTimes(1)
    expect(opfs.getFileHandle.mock.calls[0][0]).toMatch(/^paste-archive-/)
    expect(opfs.write.mock.calls.length).toBeGreaterThan(1)
    expect(opfs.close).toHaveBeenCalledTimes(1)
    expect(opfs.abort).not.toHaveBeenCalled()

    const entries = await readTestZipEntries(new Uint8Array(await archive.file.arrayBuffer()))
    expect(new TextDecoder().decode(entries["one.txt"])).toStrictEqual("one")
    expect(new TextDecoder().decode(entries["folder/two.txt"])).toStrictEqual("two")

    await archive.cleanup?.()
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1)
  })

  it("uses source size plus per-entry overhead for the pre-compression estimate", () => {
    expect(estimateArchiveSize(files)).toStrictEqual(files[0].size + files[1].size + 2 * 1024)
  })

  it("aborts and removes a partial OPFS archive when compression is cancelled", async () => {
    const controller = new AbortController()
    const opfs = mockOPFS(() => controller.abort())

    await expect(zipFiles(files, { opfsThreshold: 1, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(opfs.abort).toHaveBeenCalledTimes(1)
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1)
  })

  it("falls back to memory when a large archive cannot use OPFS", async () => {
    vi.stubGlobal("navigator", { storage: {} })

    const archive = await zipFiles(files, { opfsThreshold: 1 })

    expect(archive.cleanup).toBeUndefined()
    const entries = await readTestZipEntries(new Uint8Array(await archive.file.arrayBuffer()))
    expect(new TextDecoder().decode(entries["one.txt"])).toStrictEqual("one")
    expect(new TextDecoder().decode(entries["folder/two.txt"])).toStrictEqual("two")
  })

  it("restarts in memory when OPFS runs out of space while writing", async () => {
    const opfs = mockOPFS()
    opfs.write.mockRejectedValueOnce(new DOMException("Storage quota exceeded", "QuotaExceededError"))

    const archive = await zipFiles(files, { opfsThreshold: 1 })

    expect(opfs.abort).toHaveBeenCalledTimes(1)
    expect(opfs.removeEntry).toHaveBeenCalledTimes(1)
    expect(archive.cleanup).toBeUndefined()
    const entries = await readTestZipEntries(new Uint8Array(await archive.file.arrayBuffer()))
    expect(new TextDecoder().decode(entries["one.txt"])).toStrictEqual("one")
    expect(new TextDecoder().decode(entries["folder/two.txt"])).toStrictEqual("two")
  })

  it("packs archives with zstd when requested and round-trips through the official codec", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(readFileSync("frontend/wasm/zstd/zstd_encoder_simd.wasm"), {
            headers: { "Content-Type": "application/wasm" },
          }),
        ),
      ),
    )
    const archive = await zipFiles(files, { opfsThreshold: Number.MAX_SAFE_INTEGER, compression: "zstd" })

    expect(archive.cleanup).toBeUndefined()
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await archive.file.arrayBuffer())))
    const entries = await reader.getEntries()
    expect(entries.map((entry) => entry.filename)).toStrictEqual(["one.txt", "folder/two.txt"])
    for (const entry of entries) {
      if (entry.directory) continue
      expect(entry.compressionMethod).toBe(93)
      const raw = await entry.getData(new Uint8ArrayWriter(), { passThrough: true })
      expect(raw[4] & 0x20).toBe(0x20)
      const restored = await decompressZstd(raw, 0xffffffff)
      const expected = new TextEncoder().encode(entry.filename === "one.txt" ? "one" : "two")
      expect([...restored]).toStrictEqual([...expected])
    }
    await reader.close()
  })

  it("keeps one zstd frame across multiple input chunks in an archive entry", async () => {
    const first = new TextEncoder().encode("first archive input chunk ")
    const second = new TextEncoder().encode("second archive input chunk")
    const source = new Uint8Array(first.byteLength + second.byteLength)
    source.set(first)
    source.set(second, first.byteLength)
    const stream = new ZstdCompressionStream("zstd", { uncompressedSize: source.byteLength })
    const compressedPromise = new Response(stream.readable).arrayBuffer()
    const writer = stream.writable.getWriter()
    await writer.write(first)
    await writer.write(second)
    await writer.close()
    const raw = new Uint8Array(await compressedPromise)
    const frameMagic = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd)
    let frameCount = 0
    for (let offset = 0; offset <= raw.byteLength - frameMagic.byteLength; offset += 1) {
      if (frameMagic.every((byte, index) => raw[offset + index] === byte)) frameCount += 1
    }

    expect(frameCount).toBe(1)
    expect(await decompressZstd(raw, source.byteLength)).toStrictEqual(source)
  })

  it("forwards zip.js' uncompressed entry size to the zstd frame", async () => {
    const source = new TextEncoder().encode("pledged zip entry")
    const stream = new ZstdCompressionStream("zstd", { uncompressedSize: source.byteLength + 1 })
    const outputPromise = new Response(stream.readable).arrayBuffer()
    const writer = stream.writable.getWriter()
    await writer.write(source)
    await expect(writer.close()).rejects.toThrow(/Src size is incorrect/)
    await expect(outputPromise).rejects.toThrow(/Src size is incorrect/)
  })

  it("preserves each file's modification time like the demo", async () => {
    const lastModified = new Date(2024, 5, 15, 12, 34, 56).getTime()
    const archive = await zipFiles([new File(["one"], "one.txt", { lastModified })], {
      opfsThreshold: Number.MAX_SAFE_INTEGER,
    })

    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await archive.file.arrayBuffer())))
    const entries = await reader.getEntries()
    // ZIP timestamps only store even seconds; floor the expectation to the
    // 2000 ms boundary the round-trip can represent.
    expect(entries[0].lastModDate?.getTime()).toBe(Math.floor(lastModified / 2000) * 2000)
    await reader.close()
  })
})
