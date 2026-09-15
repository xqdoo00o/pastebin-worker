import { DEFAULT_EDIT_FILENAME } from "./constants.js"

export function itemNoun(count: number): "item" | "items" {
  return count === 1 ? "item" : "items"
}

export function itemCountLabel(count: number): string {
  return `${count} ${itemNoun(count)}`
}

export function filenameForTitle(filename: string | undefined): string | undefined {
  return filename === DEFAULT_EDIT_FILENAME ? undefined : filename
}

export function lineNumberText(lineCount: number): string {
  const count = Math.max(1, Math.floor(lineCount))
  const lines = new Array<string>(count)
  for (let index = 0; index < count; index += 1) lines[index] = String(index + 1)
  return lines.join("\n")
}

export function countTextLines(content: string): number {
  let count = 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) count += 1
  }
  return count
}
