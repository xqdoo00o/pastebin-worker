/** Immutable object versions let KV publication fail without replacing live data. */
const OBJECT_PREFIX = "pastes/"

export function newPasteObjectKey(name: string): string {
  return `${OBJECT_PREFIX}${name}/${crypto.randomUUID()}`
}

export function pasteNameFromObjectKey(key: string): string | null {
  return /^pastes\/([^/]+)\/[^/]+$/.exec(key)?.[1] ?? null
}

export function pasteObjectKey(metadata: { r2Key?: string }): string {
  if (!metadata.r2Key) throw new Error("R2 paste has no object key")
  return metadata.r2Key
}
