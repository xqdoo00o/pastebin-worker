import type { CardProps } from "./ui/index.js"
import { Card, CardBody, Tab, Tabs } from "./ui/index.js"
import type { DragEvent } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { EditKind, PasteEditState } from "../models/paste.js"
import { formatSize, verifyFileSize } from "../utils/utils.js"
import {
  FileCollectionCancelledError,
  filesFromFileList,
  filesFromTransferRecords,
  transferRecordsFromDataTransferItems,
  type TransferFileRecord,
} from "../utils/fileCollection.js"
import { PlusIcon, XIcon } from "./icons.js"
import { CodeEditor } from "./CodeEditor.js"
import { FileTree, normalizedFilePath } from "./FileTree.js"
import { itemCountLabel } from "../../shared/format.js"
import type { PublicEnv } from "../../shared/interfaces.js"

function isPasteEditorFocused(): boolean {
  const activeElement = document.activeElement
  return (
    activeElement instanceof HTMLTextAreaElement ||
    (activeElement instanceof HTMLInputElement && !activeElement.readOnly)
  )
}

function totalFileSize(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0)
}

interface PasteEditorProps extends CardProps {
  isPasteLoading: boolean
  state: PasteEditState
  onStateChange: (state: PasteEditState) => void
  config: PublicEnv
  skipFileSizeLimit?: boolean
  showModal: (title: string, content: string) => void
}

export function PasteInputPanel({
  isPasteLoading,
  state,
  onStateChange,
  config,
  skipFileSizeLimit = false,
  showModal,
  ...rest
}: PasteEditorProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const appendModeRef = useRef(false)
  const [dragTarget, setDragTarget] = useState<"replace" | "append" | "edit" | null>(null)
  const [isCollectingFiles, setIsCollectingFiles] = useState<boolean>(false)
  const collectionGeneration = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    return () => {
      collectionGeneration.current += 1
    }
  }, [])

  const resetFileInput = useCallback(() => {
    if (fileInput.current) fileInput.current.value = ""
    appendModeRef.current = false
  }, [])

  const openFilePicker = useCallback((append: boolean) => {
    appendModeRef.current = append
    fileInput.current?.click()
  }, [])

  const setFiles = useCallback(
    (files: File[]) => {
      const totalSize = totalFileSize(files)
      if (!skipFileSizeLimit) {
        const [totalOk, totalMsg] = verifyFileSize(totalSize, config)
        if (!totalOk) {
          showModal(files.length > 1 ? "Pastes too large" : "Paste too large", totalMsg)
          resetFileInput()
          return
        }
      }

      onStateChange({ ...stateRef.current, editKind: "file", files })
    },
    [config, onStateChange, resetFileInput, showModal, skipFileSizeLimit],
  )

  const cancelFileCollection = useCallback(() => {
    collectionGeneration.current += 1
    setIsCollectingFiles(false)
  }, [])

  const collectAndSetFiles = useCallback(
    async (records: TransferFileRecord[], append = false) => {
      if (records.length === 0) return

      const generation = collectionGeneration.current + 1
      collectionGeneration.current = generation
      const isCurrent = () => collectionGeneration.current === generation
      setIsCollectingFiles(true)
      try {
        const files = await filesFromTransferRecords(records, isCurrent)
        if (isCurrent() && files.length > 0) {
          setFiles(append ? [...stateRef.current.files, ...files] : files)
        }
      } catch (error) {
        if (!isCurrent()) return
        if (error instanceof FileCollectionCancelledError) return
        const message = error instanceof Error ? error.message : "The selected files could not be read."
        showModal("Could not read files", message)
        resetFileInput()
      } finally {
        if (isCurrent()) setIsCollectingFiles(false)
      }
    },
    [resetFileInput, setFiles, showModal],
  )

  const removeFiles = useCallback(
    (idOrPath: string, type: "file" | "folder") => {
      cancelFileCollection()
      setFiles(
        stateRef.current.files.filter((file, index) => {
          if (type === "file") return String(index) !== idOrPath
          const filePath = normalizedFilePath(file.name)
          const folderPath = idOrPath.replace(/\/+$/, "")
          return !(filePath === folderPath || filePath.startsWith(`${folderPath}/`))
        }),
      )
    },
    [cancelFileCollection, setFiles],
  )

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (isPasteEditorFocused()) return

      const records = transferRecordsFromDataTransferItems(e.clipboardData?.items)
      if (records.length === 0) return

      e.preventDefault()
      void collectAndSetFiles(records)
    }

    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [collectAndSetFiles])

  function onDrop(e: DragEvent, append = false) {
    e.preventDefault()
    e.stopPropagation()
    const records = transferRecordsFromDataTransferItems(e.dataTransfer?.items)
    if (records.length > 0) {
      void collectAndSetFiles(records, append)
    } else {
      const files = filesFromFileList(e.dataTransfer?.files)
      if (files.length > 0) {
        cancelFileCollection()
        setFiles(append ? [...stateRef.current.files, ...files] : files)
      }
    }
    setDragTarget(null)
  }

  const shouldShowFileTree = state.files.length > 1 || state.files.some((file) => file.name.includes("/"))

  return (
    <Card aria-label="Pastebin editor panel" {...rest}>
      <CardBody className="relative">
        <input
          type="file"
          ref={fileInput}
          className="hidden"
          onChange={(e) => {
            const files = filesFromFileList(e.target.files)
            if (files.length > 0) {
              cancelFileCollection()
              setFiles(appendModeRef.current ? [...stateRef.current.files, ...files] : files)
            }
            appendModeRef.current = false
          }}
          multiple
        />
        <Tabs
          classNames={{
            tabList: "gap-2 w-full py-0 border-divider mb-2 -ml-1",
            tab: "max-w-fit h-8 px-2",
            panel: "pb-1",
          }}
          selectedKey={state.editKind}
          onSelectionChange={(k) => {
            onStateChange({ ...state, editKind: k as EditKind })
          }}
        >
          {/*Possibly a bug of chrome, but Tab sometimes has a transient unexpected scrollbar when resizing*/}
          <Tab key="edit" title="Edit" className="overflow-hidden">
            <div
              className="relative"
              onDrop={onDrop}
              onDragEnter={(e) => {
                e.preventDefault()
                setDragTarget("edit")
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragTarget("edit")
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDragTarget(null)
                }
              }}
            >
              <CodeEditor
                content={state.editContent}
                setContent={(k) => onStateChange({ ...state, editContent: k })}
                lang={state.editHighlightLang}
                setLang={(lang) => onStateChange({ ...state, editHighlightLang: lang })}
                filename={state.editFilename}
                setFilename={(name) => onStateChange({ ...state, editFilename: name })}
                disabled={isPasteLoading}
                placeholder={isPasteLoading ? "Loading..." : "Edit your paste here"}
              />
              {dragTarget === "edit" && (
                <div
                  className={
                    `absolute inset-0 rounded-xl flex flex-col items-center justify-center ` +
                    "pointer-events-none bg-primary-100"
                  }
                  aria-hidden="true"
                >
                  <div className="text-2xl my-2 font-bold">Drop files or folders here</div>
                  <p className="text-default-500">Release to upload as file</p>
                </div>
              )}
            </div>
          </Tab>
          <Tab key="file" title="File">
            <div
              className={
                `w-full ${state.files.length > 0 ? "h-[20rem]" : "h-[23.45rem]"} rounded-xl ` +
                "relative flex cursor-pointer flex-col items-center justify-center transition-colors" +
                (dragTarget === "replace" ? " bg-primary-100" : " bg-primary-50 hover:bg-primary-100")
              }
              role="button"
              aria-label="Select file"
              onDrop={onDrop}
              onDragEnter={() => setDragTarget("replace")}
              onDragLeave={() => setDragTarget(null)}
              onDragOver={(e) => {
                e.preventDefault()
                setDragTarget("replace")
              }}
              onClick={() => openFilePicker(false)}
            >
              <div
                className={`text-2xl my-2 font-bold px-4 text-center break-all${state.files.length === 0 ? " select-none" : ""}`}
              >
                {isCollectingFiles
                  ? "Reading files..."
                  : state.files.length === 0
                    ? "Select Files"
                    : state.files.length === 1
                      ? state.files[0].name.includes("/")
                        ? `${itemCountLabel(state.files.length)} selected`
                        : state.files[0].name
                      : `${itemCountLabel(state.files.length)} selected`}
              </div>
              <p
                className={`relative ${state.files.length === 0 ? "select-none text-default-500" : "text-foreground"}`}
              >
                <span>
                  {state.files.length > 0
                    ? `${formatSize(totalFileSize(state.files))} · Click or drag or paste to replace`
                    : "Click or drag & drop or paste files here"}
                </span>
              </p>
              {shouldShowFileTree && (
                <div
                  className="mt-3 max-h-48 w-full max-w-[32rem] overflow-auto px-4 text-sm text-default-600"
                  onClick={(e) => e.stopPropagation()}
                >
                  <FileTree
                    files={state.files.map((file, index) => ({
                      id: String(index),
                      name: file.name,
                      sizeBytes: file.size,
                    }))}
                    tone="foreground"
                    onRemove={removeFiles}
                  />
                </div>
              )}
              {state.files.length > 0 && (
                <button
                  type="button"
                  aria-label="Remove file"
                  className="absolute top-2 right-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-red-400 transition-colors hover:bg-danger-100 hover:text-danger focus:outline-none focus-visible:ring-1 focus-visible:ring-default-400"
                  onClick={(e) => {
                    e.stopPropagation()
                    cancelFileCollection()
                    setFiles([])
                    resetFileInput()
                  }}
                >
                  <XIcon className="size-5" />
                </button>
              )}
            </div>
            {state.files.length > 0 && (
              <div
                className={
                  `mt-3 flex min-h-[2.7rem] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border ` +
                  `border-dashed border-default-300 text-default-600 transition-colors ${
                    dragTarget === "append" ? "bg-primary-100 text-primary" : "bg-primary-50 hover:bg-primary-100"
                  }`
                }
                role="button"
                aria-label="Add files"
                onClick={() => openFilePicker(true)}
                onDrop={(event) => onDrop(event, true)}
                onDragEnter={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setDragTarget("append")
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setDragTarget("append")
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(null)
                }}
              >
                <PlusIcon aria-hidden="true" className="size-6 shrink-0" />
                <span className="leading-6">{isCollectingFiles ? "Adding files…" : "Add files"}</span>
              </div>
            )}
          </Tab>
        </Tabs>
      </CardBody>
    </Card>
  )
}
