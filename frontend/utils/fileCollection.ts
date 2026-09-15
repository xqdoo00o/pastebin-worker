interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  isFile: true
  isDirectory: false
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void
}

interface FileSystemDirectoryReaderLike {
  readEntries: (success: (entries: FileSystemEntryLike[]) => void, error?: (error: DOMException) => void) => void
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  isFile: false
  isDirectory: true
  createReader: () => FileSystemDirectoryReaderLike
}

export type TransferFileRecord = { kind: "entry"; entry: FileSystemEntryLike } | { kind: "file"; file: File }

export class FileCollectionCancelledError extends Error {
  constructor() {
    super("File collection was superseded.")
    this.name = "FileCollectionCancelledError"
  }
}

function ensureCollectionActive(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new FileCollectionCancelledError()
}

function fileWithPath(file: File, path: string): File {
  if (file.name === path) return file
  return new File([file], path, { type: file.type, lastModified: file.lastModified })
}

function readFileEntry(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

function readDirectoryBatch(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

async function readAllDirectoryEntries(
  entry: FileSystemDirectoryEntryLike,
  isCurrent: () => boolean,
): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader()
  const entries: FileSystemEntryLike[] = []

  while (true) {
    ensureCollectionActive(isCurrent)
    const batch = await readDirectoryBatch(reader)
    ensureCollectionActive(isCurrent)
    if (batch.length === 0) break
    entries.push(...batch)
  }

  return entries
}

async function filesFromEntry(
  entry: FileSystemEntryLike,
  parentPath = "",
  isCurrent: () => boolean = () => true,
): Promise<File[]> {
  ensureCollectionActive(isCurrent)
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntryLike)
    ensureCollectionActive(isCurrent)
    return [fileWithPath(file, `${parentPath}${file.name}`)]
  }

  if (entry.isDirectory) {
    const directoryPath = `${parentPath}${entry.name}/`
    const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntryLike, isCurrent)
    if (children.length === 0) return [new File([new Uint8Array(0)], directoryPath)]

    const nestedFiles = await Promise.all(children.map((child) => filesFromEntry(child, directoryPath, isCurrent)))
    ensureCollectionActive(isCurrent)
    return nestedFiles.flat()
  }

  return []
}

export function transferRecordsFromDataTransferItems(items: DataTransferItemList | undefined): TransferFileRecord[] {
  if (!items) return []
  const records: TransferFileRecord[] = []

  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue

    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
    ).webkitGetAsEntry?.()
    if (entry) {
      records.push({ kind: "entry", entry })
      continue
    }

    const file = item.getAsFile()
    if (file) records.push({ kind: "file", file })
  }

  return records
}

export async function filesFromTransferRecords(
  records: TransferFileRecord[],
  isCurrent: () => boolean,
): Promise<File[]> {
  ensureCollectionActive(isCurrent)
  const files = await Promise.all(
    records.map((record) =>
      record.kind === "entry" ? filesFromEntry(record.entry, "", isCurrent) : Promise.resolve([record.file]),
    ),
  )
  ensureCollectionActive(isCurrent)
  return files.flat()
}

export function filesFromFileList(files: FileList | null | undefined): File[] {
  if (!files) return []
  return Array.from(files).map((file) => fileWithPath(file, file.webkitRelativePath || file.name))
}
