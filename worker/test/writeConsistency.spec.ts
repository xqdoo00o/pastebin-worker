import { afterEach, expect, it, vi } from "vitest"
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test"
import worker from "../index.js"
import { BASE_URL, upload, workerFetch } from "./testUtils.js"
import {
  cleanExpiredInR2,
  createPaste,
  getPasteMetadata,
  getPasteRecord,
  getRemainingReads,
  openPasteBody,
  pasteNameAvailable,
} from "../storage/storage.js"
import { pasteObjectKey } from "../storage/objectKey.js"
import { uploadMPU } from "../../shared/uploadPaste.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function failWrites<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key) {
      if (key === "put") return () => Promise.reject(new Error("simulated storage failure"))
      const value: unknown = Reflect.get(object, key)
      return typeof value === "function" ? (value.bind(object) as unknown) : value
    },
  })
}

function pauseMethod<T extends object>(target: T, method: keyof T) {
  let signalEntered!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    entered,
    release,
    target: new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key)
        if (typeof value !== "function") return value
        if (key !== method) return value.bind(object) as unknown
        return async (...args: unknown[]) => {
          signalEntered()
          await released
          return Reflect.apply(value, object, args) as unknown
        }
      },
    }),
  }
}

it("a delayed final read cannot remove an update already authorized before that read", async () => {
  const ctx = createExecutionContext()
  const oldBytes = "a".repeat(30 * 1024)
  const paste = await upload(ctx, { c: oldBytes, reads: "1" })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  const write = pauseMethod(env.R2, "put")
  const read = pauseMethod(env.R2, "get")
  const form = new FormData()
  form.set("c", "new content")
  form.set("reads", "3")
  const updating = worker.fetch(
    new Request(paste.manageUrl, { method: "PUT", body: form }),
    { ...env, R2: write.target },
    ctx,
  )
  await write.entered
  const reading = worker.fetch(new Request(paste.url), { ...env, R2: read.target }, ctx)
  await read.entered
  try {
    write.release()
    expect((await updating).status).toBe(200)
    const current = (await getPasteMetadata(env, name))!
    expect(current.r2Key).not.toBe(original.r2Key)
    read.release()
    const response = await reading
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(oldBytes)
    await waitOnExecutionContext(ctx)
    expect(await getPasteMetadata(env, name)).toEqual(current)
    expect(await env.R2.head(original.r2Key!)).toBeNull()
    expect(await getRemainingReads(env, name, current)).toBe(3)
    expect(await (await workerFetch(ctx, paste.url)).text()).toBe("new content")
  } finally {
    write.release()
    read.release()
    await Promise.allSettled([updating, reading])
  }
})

it("exhausted KV pastes stay inaccessible until TTL cleanup and their names can be reused", async () => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "once", reads: "1" })
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe("once")
  await waitOnExecutionContext(ctx)
  expect((await workerFetch(ctx, paste.url)).status).toBe(404)
  const form = new FormData()
  form.set("c", "cannot revive")
  expect((await workerFetch(ctx, new Request(paste.manageUrl, { method: "PUT", body: form }))).status).toBe(404)
  expect(await pasteNameAvailable(env, new URL(paste.url).pathname.slice(1))).toBe(true)
})

it("expired-version cleanup cannot delete a reused name", async () => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "a".repeat(30 * 1024) })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  await env.PB.put(name, "", {
    metadata: { ...original, willExpireAtUnix: Math.floor(Date.now() / 1000) - 1 },
    expirationTtl: 70,
  })
  const deletion = pauseMethod(env.R2, "delete")
  expect(await getPasteRecord({ ...env, R2: deletion.target }, name, ctx)).toBeNull()
  await deletion.entered
  try {
    const content = new TextEncoder().encode("new paste")
    const current = await createPaste(env, name, content.buffer, {
      now: new Date(),
      contentLength: content.byteLength,
      expirationSeconds: 3600,
      passwd: "new-password",
      isMPUComplete: false,
    })
    deletion.release()
    await waitOnExecutionContext(ctx)
    expect(await getPasteMetadata(env, name)).toEqual(current)
    expect(await (await workerFetch(ctx, paste.url)).text()).toBe("new paste")
    expect(await env.R2.head(original.r2Key!)).toBeNull()
  } finally {
    deletion.release()
    await waitOnExecutionContext(ctx)
  }
})

it.each(["update", "delete"])("late access sampling cannot undo a successful %s", async (operation) => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "old content" })
  const name = new URL(paste.url).pathname.slice(1)
  const staleRecord = (await getPasteRecord(env, name, ctx))!
  if (operation === "update") {
    await upload(ctx, { c: "new content", s: "new-password" }, { method: "PUT", url: paste.manageUrl })
  } else {
    expect((await workerFetch(ctx, new Request(paste.manageUrl, { method: "DELETE" }))).ok).toBe(true)
  }
  const committed = await env.PB.getWithMetadata(name)
  vi.spyOn(Math, "random").mockReturnValue(0)
  const body = await openPasteBody(env, name, staleRecord, ctx)
  expect(await new Response(body!.paste).text()).toBe("old content")
  await waitOnExecutionContext(ctx)
  expect(await env.PB.getWithMetadata(name)).toEqual(committed)
})

it("an oversized MPU update preserves the old object, metadata, and remaining reads", async () => {
  const ctx = createExecutionContext()
  const oldBytes = "a".repeat(30 * 1024)
  const paste = await upload(ctx, { c: oldBytes, reads: "3" })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe(oldBytes)
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return worker.fetch(request, request.url.includes("/mpu/complete") ? { ...env, R2_MAX_ALLOWED: "1K" } : env, ctx)
  })
  await expect(
    uploadMPU(BASE_URL, 5 * 1024 * 1024, {
      isUpdate: true,
      manageUrl: paste.manageUrl,
      content: new File([new Uint8Array(2048)], "large.bin"),
    }),
  ).rejects.toMatchObject({ statusCode: 413 })
  expect(await getPasteMetadata(env, name)).toEqual(original)
  expect(await getRemainingReads(env, name, original)).toBe(2)
  expect(await (await env.R2.get(pasteObjectKey(original)))!.text()).toBe(oldBytes)
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe(oldBytes)
})

it.each(["R2", "KV"] as const)("a failed %s write leaves the original counter and content usable", async (storage) => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "original", reads: "3" })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe("original")
  const failedEnv = storage === "R2" ? { ...env, R2: failWrites(env.R2) } : { ...env, PB: failWrites(env.PB) }
  const form = new FormData()
  form.set("c", new File([new Uint8Array(30 * 1024)], "new.bin"))
  form.set("reads", "5")
  const response = await worker.fetch(new Request(paste.manageUrl, { method: "PUT", body: form }), failedEnv, ctx)
  expect(response.status).toBe(500)
  expect(await env.PB.get(name)).toBe("original")
  expect(await getPasteMetadata(env, name)).toEqual(original)
  expect(await getRemainingReads(env, name, original)).toBe(2)
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe("original")
})

it("a failed direct R2 update cannot replace live bytes when KV publication fails", async () => {
  const ctx = createExecutionContext()
  const oldBytes = "old".repeat(10 * 1024)
  const paste = await upload(ctx, { c: oldBytes })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  const form = new FormData()
  form.set("c", "replacement")
  const response = await worker.fetch(
    new Request(paste.manageUrl, { method: "PUT", body: form }),
    { ...env, PB: failWrites(env.PB) },
    ctx,
  )
  expect(response.status).toBe(500)
  expect(await getPasteMetadata(env, name)).toEqual(original)
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe(oldBytes)
})

it("a failed KV delete preserves the R2 body and the remaining reads", async () => {
  const ctx = createExecutionContext()
  const content = "persist".repeat(5 * 1024)
  const paste = await upload(ctx, { c: content, reads: "3" })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  const failingPB = new Proxy(env.PB, {
    get(target, key) {
      if (key === "delete") return () => Promise.reject(new Error("simulated KV delete failure"))
      const value: unknown = Reflect.get(target, key)
      return typeof value === "function" ? (value.bind(target) as unknown) : value
    },
  })

  const response = await worker.fetch(
    new Request(paste.manageUrl, { method: "DELETE" }),
    { ...env, PB: failingPB },
    ctx,
  )
  expect(response.status).toBe(500)
  expect(await response.text()).toBe("Error 500: internal server error\n")
  expect(await getPasteMetadata(env, name)).toEqual(original)
  expect(await getRemainingReads(env, name, original)).toBe(3)
  expect(await env.R2.head(original.r2Key!)).not.toBeNull()
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe(content)
})

it("deletes the KV index before the R2 object is reclaimed by the sweep", async () => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "x".repeat(30 * 1024) })
  const name = new URL(paste.url).pathname.slice(1)
  const objectKey = (await getPasteMetadata(env, name))!.r2Key!

  expect((await workerFetch(ctx, new Request(paste.manageUrl, { method: "DELETE" }))).status).toBe(200)
  expect(await getPasteMetadata(env, name)).toBeNull()
  expect(await env.R2.head(objectKey)).not.toBeNull()
  await cleanExpiredInR2(env, createScheduledController({ scheduledTime: Date.now() + 6 * 60_000 }))
  expect(await env.R2.head(objectKey)).toBeNull()
})

it("publishes a new R2 version and cleans only unreferenced versions after the grace period", async () => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "a".repeat(30 * 1024), reads: "2" })
  const name = new URL(paste.url).pathname.slice(1)
  const original = (await getPasteMetadata(env, name))!
  await upload(ctx, { c: "new", reads: "3" }, { method: "PUT", url: paste.manageUrl })
  const current = (await getPasteMetadata(env, name))!
  expect(current.r2Key).not.toBe(original.r2Key)
  expect(await getRemainingReads(env, name, original)).toBeNull()
  expect(await getRemainingReads(env, name, current)).toBe(3)
  expect(await env.R2.head(original.r2Key!)).not.toBeNull()
  // R2 timestamps use the runtime clock; advance the scheduled sweep beyond its grace window.
  await cleanExpiredInR2(env, createScheduledController({ scheduledTime: Date.now() + 6 * 60_000 }))
  expect(await env.R2.head(original.r2Key!)).toBeNull()
  expect(await env.R2.head(current.r2Key!)).not.toBeNull()
  expect(await (await workerFetch(ctx, paste.url)).text()).toBe("new")
})
