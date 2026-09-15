import { useMemo, useState } from "react"
import { formatSize } from "../utils/utils.js"
import { ChevronDownIcon, FileIcon, FolderIcon, XIcon } from "./icons.js"
import { itemCountLabel } from "../../shared/format.js"
import { dedupeFilename } from "../../shared/fileType.js"

export interface FileTreeEntry {
  /** Stable identity used for actions. Defaults to the normalized path. */
  id?: string
  name: string
  sizeBytes: number
}

interface FileTreeNode {
  name: string
  path: string
  removeId?: string
  type: "file" | "folder"
  sizeBytes: number
  children: FileTreeNode[]
}

interface MutableFileTreeNode {
  name: string
  path: string
  removeId?: string
  type: "file" | "folder"
  sizeBytes: number
  children: Map<string, MutableFileTreeNode>
}

interface FileTreeProps {
  files: FileTreeEntry[]
  className?: string
  compact?: boolean
  tone?: "muted" | "foreground"
  /** When provided, each entry gets a remove button. Files use their stable id; folders use their normalized path. */
  onRemove?: (idOrPath: string, type: "file" | "folder") => void
}

export function normalizedFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "")
}

function childKey(type: FileTreeNode["type"], name: string): string {
  return `${type}:${name}`
}

function uniqueFileName(siblings: Map<string, MutableFileTreeNode>, name: string): string {
  return dedupeFilename(name, (candidate) => siblings.has(childKey("file", candidate)))
}

function toReadonlyNode(node: MutableFileTreeNode): FileTreeNode {
  const children = Array.from(node.children.values())
    .map(toReadonlyNode)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  return { ...node, children }
}

function buildFileTree(files: FileTreeEntry[]): FileTreeNode[] {
  const root = new Map<string, MutableFileTreeNode>()

  function getOrCreateFolder(
    siblings: Map<string, MutableFileTreeNode>,
    name: string,
    path: string,
  ): MutableFileTreeNode {
    const key = childKey("folder", name)
    const existing = siblings.get(key)
    if (existing) return existing

    const node: MutableFileTreeNode = {
      name,
      path,
      type: "folder",
      sizeBytes: 0,
      children: new Map(),
    }
    siblings.set(key, node)
    return node
  }

  for (const file of files) {
    const path = normalizedFilePath(file.name)
    if (!path) continue

    const isFolder = path.endsWith("/")
    const parts = path.split("/").filter(Boolean)
    let siblings = root
    let currentPath = ""

    parts.forEach((part, index) => {
      const isLast = index === parts.length - 1
      currentPath += `${part}${isLast && !isFolder ? "" : "/"}`

      if (isLast && !isFolder) {
        const displayName = uniqueFileName(siblings, part)
        const displayPath = `${currentPath.slice(0, currentPath.length - part.length)}${displayName}`
        siblings.set(childKey("file", displayName), {
          name: displayName,
          path: displayPath,
          removeId: file.id ?? path,
          type: "file",
          sizeBytes: file.sizeBytes,
          children: new Map(),
        })
        return
      }

      const folder = getOrCreateFolder(siblings, part, currentPath)
      siblings = folder.children
    })
  }

  return Array.from(root.values())
    .map(toReadonlyNode)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

function folderMeta(node: FileTreeNode): string {
  return node.children.length === 0 ? "0 item" : itemCountLabel(node.children.length)
}

function FileTreeRows({
  nodes,
  depth,
  expandedPaths,
  toggleExpanded,
  compact,
  tone,
  onRemove,
}: {
  nodes: FileTreeNode[]
  depth: number
  expandedPaths: Set<string>
  toggleExpanded: (path: string) => void
  compact: boolean
  tone: "muted" | "foreground"
  onRemove?: (idOrPath: string, type: "file" | "folder") => void
}) {
  const detailColor = tone === "foreground" ? "text-foreground" : "text-default-500"

  return (
    <>
      {nodes.map((node) => {
        const isExpanded = expandedPaths.has(node.path)
        const indent = { paddingLeft: `${depth * (compact ? 0.5 : 0.8)}rem` }
        const removeButton = onRemove && (
          <button
            type="button"
            aria-label={`Remove ${node.name}`}
            className="flex shrink-0 cursor-pointer items-center rounded p-0.5 text-default-400 transition-colors hover:bg-danger-100 hover:text-danger focus:outline-none focus-visible:ring-1 focus-visible:ring-default-400"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(node.type === "file" ? (node.removeId ?? node.path) : node.path, node.type)
            }}
          >
            <XIcon className="size-4" />
          </button>
        )

        if (node.type === "folder") {
          return (
            <div key={`folder-${node.path}`}>
              <div
                className={`flex items-center justify-between rounded px-1 py-1 hover:bg-default-200 ${compact ? "gap-1.5" : "gap-3"}`}
                style={indent}
              >
                <button
                  type="button"
                  className="-my-1 -ml-1 flex min-w-0 flex-1 cursor-pointer items-center rounded py-1 pl-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-default-400"
                  aria-expanded={isExpanded}
                  onClick={() => toggleExpanded(node.path)}
                >
                  <ChevronDownIcon className={`size-4 shrink-0 ${isExpanded ? "" : "-rotate-90"}`} />
                  <FolderIcon className={`size-4 shrink-0 ${detailColor}`} />
                  <span className="ml-1 truncate select-none" title={node.path}>
                    {node.name}
                  </span>
                </button>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className={`text-xs ${detailColor}`}>{folderMeta(node)}</span>
                  {removeButton}
                </span>
              </div>
              {isExpanded && node.children.length > 0 && (
                <FileTreeRows
                  nodes={node.children}
                  depth={depth + 1}
                  expandedPaths={expandedPaths}
                  toggleExpanded={toggleExpanded}
                  compact={compact}
                  tone={tone}
                  onRemove={onRemove}
                />
              )}
            </div>
          )
        }

        return (
          <div
            key={`file-${node.path}`}
            className="flex items-center justify-between gap-3 rounded px-1 py-1"
            style={indent}
          >
            <span className="flex min-w-0 items-center">
              <span className="size-4 shrink-0" />
              <FileIcon className={`size-4 shrink-0 ${detailColor}`} />
              <span className="ml-1 truncate" title={node.path}>
                {node.name}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`shrink-0 text-xs ${detailColor}`}>{formatSize(node.sizeBytes)}</span>
              {removeButton}
            </span>
          </div>
        )
      })}
    </>
  )
}

export function FileTree({ files, className = "", compact = false, tone = "muted", onRemove }: FileTreeProps) {
  const nodes = useMemo(() => buildFileTree(files), [files])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())

  function toggleExpanded(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className={`text-sm ${tone === "foreground" ? "text-foreground" : "text-default-600"} ${className}`}>
      <FileTreeRows
        nodes={nodes}
        depth={0}
        expandedPaths={expandedPaths}
        toggleExpanded={toggleExpanded}
        compact={compact}
        tone={tone}
        onRemove={onRemove}
      />
    </div>
  )
}
