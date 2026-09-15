import { DEFAULT_EDIT_FILENAME, TEXT_MIME_TYPE } from "../../shared/constants.js"
import type { OriginalFileInfo } from "../../shared/interfaces.js"
import type { PasteEditState } from "../models/paste.js"
import type { ArchiveCompression } from "./archiveCore.js"
import { ErrorWithTitle, isFileReadError } from "./errors.js"
import { readFileSlice } from "./byteSource.js"
import { isPrecompressedFile } from "./precompressed.js"
import type { PasteSetting } from "./pasteSetting.js"

export interface PreparedContent {
  content: File
  originalFiles?: OriginalFileInfo[]
  cleanup?: () => Promise<void>
}

export interface PrepareContentOptions {
  errorTitle?: string
  signal?: AbortSignal
  /** How generated ZIP archives are compressed; defaults to deflate. */
  archiveCompression?: ArchiveCompression
  /** Also package a single ordinary file as a ZIP archive. */
  compressSingleFile?: boolean
}

/** Content shape used by both the archive writer and settings UI. */
export interface ContentPackagingInfo {
  hasMultipleFiles: boolean
  hasSingleContent: boolean
  isSingleFile: boolean
  isSinglePrecompressedFile: boolean
}

export function getContentPackagingInfo(files: readonly File[], hasEditContent = false): ContentPackagingInfo {
  const hasMultipleFiles = files.length > 1 || files.some((file) => file.name.includes("/"))
  const isSingleFile = files.length === 1 && !files[0].name.includes("/")
  return {
    hasMultipleFiles,
    hasSingleContent: isSingleFile || hasEditContent,
    isSingleFile,
    isSinglePrecompressedFile: isSingleFile && isPrecompressedFile(files[0]),
  }
}

function snapshotEditorState(editorState: PasteEditState): PasteEditState {
  return { ...editorState, files: [...editorState.files] }
}

function isSamePreparedContent(left: PasteEditState, right: PasteEditState): boolean {
  if (left.editKind !== right.editKind) return false
  if (left.editKind === "edit") {
    return left.editContent === right.editContent && left.editFilename === right.editFilename
  }
  return left.files.length === right.files.length && left.files.every((file, index) => file === right.files[index])
}

/** Compares editor state including its highlight language. */
export function isSameEditorState(left: PasteEditState, right: PasteEditState): boolean {
  return (
    isSamePreparedContent(left, right) &&
    (left.editKind !== "edit" || left.editHighlightLang === right.editHighlightLang)
  )
}

/** Scalar settings that participate in update-staleness checks. */
export type UpdateFieldValue = boolean | number | string | undefined
export type UpdateFields = Record<string, UpdateFieldValue>

type ContentTransferSetting = Pick<
  PasteSetting,
  "expiration" | "readLimit" | "archiveCompression" | "compressSingleFile"
>

/** Fields shared by upload and P2P that change the prepared content or its lifetime. */
function contentTransferUpdateFields(setting: ContentTransferSetting) {
  return {
    expiration: setting.expiration,
    readLimit: setting.readLimit,
    archiveCompression: setting.archiveCompression,
    compressSingleFile: setting.compressSingleFile ?? false,
  } satisfies UpdateFields
}

export function uploadUpdateFields(setting: PasteSetting) {
  return {
    ...contentTransferUpdateFields(setting),
    manageUrl: setting.manageUrl,
    doEncrypt: setting.doEncrypt,
  } satisfies UpdateFields
}

export function p2pUpdateFields(setting: PasteSetting) {
  return {
    ...contentTransferUpdateFields(setting),
    verifyP2P: setting.verifyP2P,
  } satisfies UpdateFields
}

/** A snapshot of the editor plus the settings that decide whether a paste/transfer is stale. */
export interface UpdateSnapshot<T extends UpdateFields = UpdateFields> {
  editorState: PasteEditState
  fields: T
}

export function createUpdateSnapshot<const T extends UpdateFields>(
  editorState: PasteEditState,
  fields: T,
): UpdateSnapshot<T> {
  return { editorState: snapshotEditorState(editorState), fields }
}

/**
 * True when the current editor or any of the given fields differ from a
 * previous snapshot. Only the keys present in `fields` are compared, so
 * callers can check a subset of the snapshot's settings.
 */
export function hasUpdateChanged<T extends UpdateFields>(
  snapshot: UpdateSnapshot<T>,
  editorState: PasteEditState,
  fields: T,
): boolean {
  return (
    !isSameEditorState(snapshot.editorState, editorState) ||
    Object.keys(fields).some((key) => snapshot.fields[key] !== fields[key])
  )
}

async function assertFileReadable(file: File, errorTitle: string, signal?: AbortSignal): Promise<void> {
  try {
    await readFileSlice(file, 0, Math.min(file.size, 1), signal)
  } catch (error) {
    if (isFileReadError(error)) throw new ErrorWithTitle(errorTitle, error.message)
    throw error
  }
}

export async function prepareContent(
  editorState: PasteEditState,
  {
    errorTitle = "Error on Preparing Content",
    archiveCompression,
    compressSingleFile = false,
    signal,
  }: PrepareContentOptions = {},
): Promise<PreparedContent> {
  signal?.throwIfAborted()

  if (editorState.editKind === "edit") {
    if (editorState.editContent.length === 0) {
      throw new ErrorWithTitle(errorTitle, "Empty paste")
    }
    const content = new File([editorState.editContent], editorState.editFilename || DEFAULT_EDIT_FILENAME, {
      type: TEXT_MIME_TYPE,
    })
    if (!compressSingleFile) return { content }
    const originalFiles: OriginalFileInfo[] = [{ name: content.name, sizeBytes: content.size }]
    const { zipFiles } = await import("./archive.js")
    const archive = await zipFiles([content], { signal, compression: archiveCompression })
    return { content: archive.file, originalFiles, cleanup: archive.cleanup }
  }

  if (editorState.files.length === 0) {
    throw new ErrorWithTitle(errorTitle, "No file selected")
  }
  for (const file of editorState.files) await assertFileReadable(file, errorTitle, signal)

  const packaging = getContentPackagingInfo(editorState.files)
  if (!packaging.hasMultipleFiles && !compressSingleFile) return { content: editorState.files[0] }

  const originalFiles = editorState.files.map((file) => ({ name: file.name, sizeBytes: file.size }))
  try {
    const { zipFiles } = await import("./archive.js")
    const archive = await zipFiles(editorState.files, { signal, compression: archiveCompression })
    return { content: archive.file, originalFiles, cleanup: archive.cleanup }
  } catch (error) {
    if (isFileReadError(error)) throw new ErrorWithTitle(errorTitle, error.message)
    throw error
  }
}
