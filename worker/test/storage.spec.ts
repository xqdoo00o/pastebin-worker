import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test"
import { addRole, BASE_URL, genRandomBlob, upload, workerFetch } from "./testUtils.js"
import worker from "../index.js"
import { parseSize } from "../../shared/parsers.js"
import {
  allocateRandomPasteName,
  cleanExpiredInR2,
  discardPasteRecord,
  getPasteMetadata,
  getPasteRecord,
  openPasteBody,
  type PasteMetadata,
} from "../storage/storage.js"

beforeEach(vi.useFakeTimers)
afterEach(vi.useRealTimers)

describe("getPaste / getPasteMetadata expiration", () => {
  it("returns 404 once a paste has expired and leaves KV cleanup to its TTL", async () => {
    const ctx = createExecutionContext()

    vi.setSystemTime(new Date(2030, 0, 1))
    const seeded = await upload(ctx, { c: new Blob(["hello"]), e: "70" })
    const url = seeded.url
    const name = url.slice(BASE_URL.length + 1)
    const original = await env.PB.getWithMetadata<PasteMetadata>(name)

    // sanity: still alive right after upload
    expect((await workerFetch(ctx, url)).status).toStrictEqual(200)

    // Fake time changes the Worker clock, not the backing KV service's TTL clock.
    vi.setSystemTime(new Date(2030, 0, 2))
    const stale = await workerFetch(ctx, url)
    expect(stale.status).toStrictEqual(404)
    await waitOnExecutionContext(ctx)

    // Readers must not delete a mutable name index; a concurrent update may own it.
    const raw = await env.PB.getWithMetadata<PasteMetadata>(name)
    expect(raw).toEqual(original)
    const listed = await env.PB.list({ prefix: name })
    expect(listed.keys.find((key) => key.name === name)?.expiration).toBe(original.metadata!.willExpireAtUnix)

    expect((await workerFetch(ctx, addRole(url, "m"))).status).toStrictEqual(404)
    expect(await getPasteMetadata(env, name)).toBeNull()
  })
})

describe("paste record body opening", () => {
  const metadata = (location: "KV" | "R2"): PasteMetadata => ({
    schemaVersion: 1,
    location,
    r2Key: location === "R2" ? "pastes/paste/version" : undefined,
    cacheVersion: "version",
    passwd: "password",
    lastModifiedAtUnix: 1,
    createdAtUnix: 1,
    willExpireAtUnix: Number.MAX_SAFE_INTEGER,
    sizeBytes: 5,
  })

  it("defers R2 GET until the record body is opened", async () => {
    const r2Body = new Response("hello").body!
    const unusedKvBody = new Response("").body!
    const cancel = vi.spyOn(unusedKvBody, "cancel")
    const getWithMetadata = vi.fn().mockResolvedValue({
      value: unusedKvBody,
      metadata: metadata("R2"),
    })
    const get = vi.fn().mockResolvedValue({ body: r2Body })
    const testEnv = { PB: { getWithMetadata }, R2: { get } } as unknown as Env
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext
    const random = vi.spyOn(Math, "random").mockReturnValue(1)

    const record = await getPasteRecord(testEnv, "paste", ctx)
    expect(record).not.toBeNull()
    expect(getWithMetadata).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(get).not.toHaveBeenCalled()

    const body = await openPasteBody(testEnv, "paste", record!, ctx)
    expect(get).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledWith("pastes/paste/version", undefined)
    expect(await new Response(body!.paste).text()).toStrictEqual("hello")
    random.mockRestore()
  })

  it("cancels the body returned by metadata-only KV reads", async () => {
    const unusedBody = new Response("unused").body!
    const cancel = vi.spyOn(unusedBody, "cancel")
    const getWithMetadata = vi.fn().mockResolvedValue({
      value: unusedBody,
      metadata: metadata("R2"),
    })
    const testEnv = { PB: { getWithMetadata } } as unknown as Env

    await expect(getPasteMetadata(testEnv, "paste")).resolves.toMatchObject({ location: "R2" })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("reuses the KV stream returned with metadata", async () => {
    const getWithMetadata = vi.fn().mockResolvedValue({
      value: new Response("hello").body,
      metadata: metadata("KV"),
    })
    const testEnv = { PB: { getWithMetadata } } as unknown as Env
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext
    const random = vi.spyOn(Math, "random").mockReturnValue(1)

    const record = await getPasteRecord(testEnv, "paste", ctx)
    const body = await openPasteBody(testEnv, "paste", record!, ctx)

    expect(getWithMetadata).toHaveBeenCalledOnce()
    expect(await new Response(body!.paste).text()).toStrictEqual("hello")
    random.mockRestore()
  })

  it("cancels an unopened KV body exactly once when its record is discarded", async () => {
    const unusedBody = new Response("unused").body!
    const cancel = vi.spyOn(unusedBody, "cancel")
    const record = { metadata: metadata("KV"), kvBody: unusedBody }

    await discardPasteRecord(record)
    await discardPasteRecord(record)

    expect(cancel).toHaveBeenCalledOnce()
    expect(record.kvBody).toBeNull()
  })
})

describe("pasteNameAvailable", () => {
  it("retries generated names that are already active", async () => {
    const getWithMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        value: "taken",
        metadata: { willExpireAtUnix: Number.MAX_SAFE_INTEGER },
      })
      .mockResolvedValueOnce({ value: null, metadata: null })
    const generateName = vi.fn().mockReturnValueOnce("aaaaaa").mockReturnValueOnce("bbbbbb")
    const testEnv = { PB: { getWithMetadata } } as unknown as Env

    await expect(allocateRandomPasteName(testEnv, 6, { generateName })).resolves.toStrictEqual("bbbbbb")
    expect(generateName).toHaveBeenCalledTimes(2)
    expect(getWithMetadata).toHaveBeenNthCalledWith(1, "aaaaaa")
    expect(getWithMetadata).toHaveBeenNthCalledWith(2, "bbbbbb")
  })

  it("fails instead of overwriting after exhausting random name attempts", async () => {
    const getWithMetadata = vi.fn().mockResolvedValue({
      value: "taken",
      metadata: { willExpireAtUnix: Number.MAX_SAFE_INTEGER },
    })
    const testEnv = { PB: { getWithMetadata } } as unknown as Env

    await expect(
      allocateRandomPasteName(testEnv, 6, { maxAttempts: 2, generateName: () => "aaaaaa" }),
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(getWithMetadata).toHaveBeenCalledTimes(2)
  })
})

describe("cleanExpiredInR2", () => {
  it("limits MPU object metadata lookups to 32 concurrent requests", async () => {
    let active = 0
    let maxActive = 0
    let releaseLookups!: () => void
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookups = resolve
    })
    const objects = Array.from({ length: 70 }, (_, index) => ({
      key: `pastes/mpu-${index}/version`,
      uploaded: new Date(0),
    }))
    const getWithMetadata = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await lookupGate
      active -= 1
      return { value: null, metadata: null }
    })
    const remove = vi.fn(() => Promise.resolve())
    const testEnv = {
      PB: {
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata,
      },
      R2: {
        list: vi.fn(() => Promise.resolve({ objects, truncated: false })),
        delete: remove,
      },
    } as unknown as Env

    const cleaning = cleanExpiredInR2(testEnv, createScheduledController({ scheduledTime: new Date(2040, 0, 1) }))
    await vi.waitFor(() => expect(active).toStrictEqual(32))
    expect(maxActive).toStrictEqual(32)

    releaseLookups()
    await cleaning
    expect(getWithMetadata).toHaveBeenCalledTimes(70)
    expect(remove).toHaveBeenCalledWith(objects.map((object) => object.key))
  })

  it("deletes expired objects page by page instead of retaining every key", async () => {
    const operations: string[] = []
    const list = vi
      .fn()
      .mockImplementationOnce(() => {
        operations.push("list:first")
        return Promise.resolve({
          objects: [{ key: "expired-a", uploaded: new Date(0), customMetadata: { willExpireAtUnix: "1" } }],
          truncated: true,
          cursor: "next",
        })
      })
      .mockImplementationOnce(() => {
        operations.push("list:second")
        return Promise.resolve({
          objects: [{ key: "expired-b", uploaded: new Date(0), customMetadata: { willExpireAtUnix: "1" } }],
          truncated: false,
        })
      })
    const remove = vi.fn((keys: string[]) => {
      operations.push(`delete:${keys.join(",")}`)
      return Promise.resolve()
    })
    const testEnv = {
      R2: { list, delete: remove },
      PB: {
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
    } as unknown as Env

    await cleanExpiredInR2(testEnv, createScheduledController({ scheduledTime: new Date(2040, 0, 1) }))

    expect(operations).toStrictEqual(["list:first", "delete:expired-a", "list:second", "delete:expired-b"])
  })

  it("persists a bucket cursor after the page budget and resumes on the next sweep", async () => {
    const cursors = new Map<string, string>()
    const list = vi.fn(({ cursor }: { cursor?: string }) => {
      const page = cursor ? Number(cursor.slice("page-".length)) : 0
      return Promise.resolve({
        objects: [],
        truncated: page < 2,
        cursor: `page-${page + 1}`,
      })
    })
    const testEnv = {
      PB: {
        get: vi.fn((key: string) => Promise.resolve(cursors.get(key) ?? null)),
        put: vi.fn((key: string, value: string) => {
          cursors.set(key, value)
          return Promise.resolve()
        }),
        delete: vi.fn((key: string) => {
          cursors.delete(key)
          return Promise.resolve()
        }),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      },
      R2: { list },
    } as unknown as Env
    const controller = createScheduledController({ scheduledTime: new Date(2040, 0, 1) })

    await cleanExpiredInR2(testEnv, controller)
    expect(list).toHaveBeenCalledTimes(2)
    expect([...cursors.values()]).toEqual(["page-2"])

    await cleanExpiredInR2(testEnv, controller)
    expect(list).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenLastCalledWith({ cursor: "page-2", limit: 128, include: ["customMetadata"] })
    expect(cursors.size).toBe(0)
  })

  it("skips KV lookups for direct R2 objects whose stored expiration is still in the future", async () => {
    const now = new Date(2040, 0, 1).getTime()
    const getWithMetadata = vi.fn()
    const remove = vi.fn()
    const testEnv = {
      PB: {
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata,
      },
      R2: {
        list: vi.fn().mockResolvedValue({
          objects: [
            {
              key: "pastes/name/version",
              uploaded: new Date(now - 60 * 60_000),
              customMetadata: { willExpireAtUnix: String(now / 1000 + 3600) },
            },
          ],
          truncated: false,
        }),
        delete: remove,
      },
    } as unknown as Env

    await cleanExpiredInR2(testEnv, createScheduledController({ scheduledTime: now }))
    expect(getWithMetadata).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it("keeps a queued R2 object while the live KV index still references it", async () => {
    const ctx = createExecutionContext()
    const paste = await upload(ctx, { c: "live".repeat(8 * 1024) })
    const name = new URL(paste.url).pathname.slice(1)
    const objectKey = (await getPasteMetadata(env, name))!.r2Key!
    const markerKey = `__pb_internal/r2-cleanup/${objectKey}`
    await env.PB.put(markerKey, "", { metadata: { queuedAtMs: Date.now() - 10 * 60_000 } })
    try {
      await cleanExpiredInR2(env, createScheduledController({ scheduledTime: Date.now() }))
      expect(await env.R2.head(objectKey)).not.toBeNull()
      expect(await env.PB.get(markerKey)).not.toBeNull()
      const response = await workerFetch(ctx, paste.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("live".repeat(8 * 1024))
    } finally {
      await env.PB.delete(markerKey)
    }
  })

  it("allows a newly completed MPU time to publish its index, then removes an orphan", async () => {
    const uploaded = Date.now()
    const getWithMetadata = vi.fn().mockResolvedValue({ value: null, metadata: null })
    const remove = vi.fn().mockResolvedValue(undefined)
    const testEnv = {
      PB: {
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata,
      },
      R2: {
        list: vi
          .fn()
          .mockResolvedValue({ objects: [{ key: "pending-index", uploaded: new Date(uploaded) }], truncated: false }),
        delete: remove,
      },
    } as unknown as Env
    await cleanExpiredInR2(testEnv, createScheduledController({ scheduledTime: uploaded + 60_000 }))
    expect(getWithMetadata).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    await cleanExpiredInR2(testEnv, createScheduledController({ scheduledTime: uploaded + 6 * 60_000 }))
    expect(remove).toHaveBeenCalledWith(["pending-index"])
  })

  it("cleans up R2 objects without custom expiration metadata when their KV record is gone", async () => {
    const ctx = createExecutionContext()

    // Write a completed MPU object directly with no customMetadata.
    // objects whose expiration must be looked up from KV (the needKvLookup branch).
    const orphanKey = "pastes/orphan/version"
    await env.R2.put(orphanKey, "stale data")
    expect(await env.R2.head(orphanKey)).not.toBeNull()

    // also seed an R2-backed paste through the normal pipeline so we exercise the
    // customMetadata.willExpireAtUnix branch with an expired entry.
    vi.setSystemTime(new Date(2032, 0, 1))
    const big = genRandomBlob(parseSize(env.R2_THRESHOLD)! * 2)
    const seeded = await upload(ctx, { c: big, e: "70" })
    const seededName = seeded.url.slice(BASE_URL.length + 1)
    const seededKey = (await getPasteMetadata(env, seededName))!.r2Key!
    expect(await env.R2.head(seededKey)).not.toBeNull()

    // jump far into the future and run the scheduled cleanup
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(2040, 0, 0) }), env, ctx)
    await waitOnExecutionContext(ctx)

    expect(await env.R2.head(orphanKey)).toBeNull()
    expect(await env.R2.head(seededKey)).toBeNull()
  })
})
