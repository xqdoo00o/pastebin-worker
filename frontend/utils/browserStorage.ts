export type StorageReader = Pick<Storage, "getItem">
export type StorageWriter = Pick<Storage, "setItem">

export function browserStorage(kind: "local" | "session"): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined
    return kind === "local" ? window.localStorage : window.sessionStorage
  } catch {
    return undefined
  }
}

export function readStorageItem(storage: StorageReader | undefined, key: string): string | undefined {
  if (!storage) return undefined
  try {
    return storage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export function setStorageItem(storage: StorageWriter | undefined, key: string, value: string): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeStorageItem(storage: Pick<Storage, "removeItem"> | undefined, key: string): boolean {
  if (!storage) return false
  try {
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function readStorageJson<T>(
  storage: StorageReader | undefined,
  key: string,
  normalize: (value: unknown) => T | undefined,
): T | undefined {
  const raw = readStorageItem(storage, key)
  if (raw === undefined) return undefined
  try {
    return normalize(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

export function writeStorageJson(storage: StorageWriter | undefined, key: string, value: unknown): boolean {
  try {
    return setStorageItem(storage, key, JSON.stringify(value))
  } catch {
    return false
  }
}

export function storageKeysWithPrefix(storage: Storage | undefined, prefix: string): string[] {
  if (!storage) return []
  const keys: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
  } catch {
    return []
  }
  return keys
}
