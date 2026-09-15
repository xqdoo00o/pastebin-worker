import { afterEach, describe, expect, it, vi } from "vitest"

import {
  readStorageJson,
  removeStorageItem,
  setStorageItem,
  storageKeysWithPrefix,
  writeStorageJson,
} from "../utils/browserStorage.js"
import { WorkerRequestMap } from "../utils/workerRequests.js"

afterEach(() => {
  window.localStorage.clear()
})

describe("browser storage helpers", () => {
  it("round-trips validated JSON and enumerates a key prefix", () => {
    const storage = window.localStorage
    storage.clear()
    expect(writeStorageJson(storage, "test:one", { value: 1 })).toBe(true)
    expect(setStorageItem(storage, "test:two", "2")).toBe(true)
    expect(storageKeysWithPrefix(storage, "test:").sort()).toEqual(["test:one", "test:two"])
    expect(readStorageJson(storage, "test:one", (value) => value as { value: number })).toEqual({ value: 1 })
    expect(removeStorageItem(storage, "test:two")).toBe(true)
  })

  it("contains unavailable and malformed storage failures", () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error("disabled")
      }),
      setItem: vi.fn(() => {
        throw new Error("full")
      }),
      removeItem: vi.fn(() => {
        throw new Error("disabled")
      }),
    }
    expect(readStorageJson(broken, "key", () => "value")).toBeUndefined()
    expect(writeStorageJson(broken, "key", {})).toBe(false)
    expect(removeStorageItem(broken, "key")).toBe(false)
  })
})

describe("WorkerRequestMap", () => {
  it("correlates out-of-order responses", async () => {
    const requests = new WorkerRequestMap<string>()
    const ids: number[] = []
    const first = requests.request((id) => ids.push(id))
    const second = requests.request((id) => ids.push(id))
    requests.resolve(ids[1], "second")
    requests.resolve(ids[0], "first")
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
  })

  it("rejects a failed send and all requests on shutdown", async () => {
    const requests = new WorkerRequestMap<string>()
    const sendFailure = requests.request(() => {
      throw new Error("send failed")
    })
    await expect(sendFailure).rejects.toThrow("send failed")

    const pending = requests.request(() => undefined)
    requests.rejectAll(new Error("closed"))
    await expect(pending).rejects.toThrow("closed")
  })
})
