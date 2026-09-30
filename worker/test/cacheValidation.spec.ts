import { createExecutionContext } from "cloudflare:test"
import { afterEach, expect, it, vi } from "vitest"
import { addRole, upload, workerFetch } from "./testUtils.js"

afterEach(() => vi.useRealTimers())

it.each(["KV", "R2"])("revalidates same-second %s updates using version ETags", async (storage) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2035-01-01T00:00:00.100Z"))
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: storage === "R2" ? "a".repeat(30 * 1024) : "old" })
  const before = await workerFetch(ctx, paste.url)
  const oldEtag = before.headers.get("ETag")!
  const lastModified = before.headers.get("Last-Modified")!
  await before.arrayBuffer()
  vi.setSystemTime(new Date("2035-01-01T00:00:00.800Z"))
  await upload(ctx, { c: "new" }, { method: "PUT", url: paste.manageUrl })
  const validators: Record<string, string>[] = [
    { "If-Modified-Since": lastModified },
    { "If-None-Match": oldEtag, "If-Modified-Since": lastModified },
  ]
  for (const headers of validators) {
    const response = await workerFetch(ctx, new Request(paste.url, { headers }))
    expect(response.status).toBe(200)
    expect(response.headers.get("ETag")).not.toBe(oldEtag)
    expect(await response.text()).toBe("new")
  }
  if (storage === "R2") {
    for (const validator of [lastModified, oldEtag]) {
      const response = await workerFetch(
        ctx,
        new Request(paste.url, {
          headers: { Range: "bytes=0-0", "If-Range": validator },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("new")
    }
  }
})

it("supports HEAD, weak/list validators and If-None-Match precedence", async () => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "hello" })
  const head = await workerFetch(ctx, new Request(paste.url, { method: "HEAD" }))
  const etag = head.headers.get("ETag")!
  expect(etag).toBeTruthy()
  for (const validator of [etag, `"other", W/${etag}`, "*"]) {
    const response = await workerFetch(ctx, new Request(paste.url, { headers: { "If-None-Match": validator } }))
    expect(response.status).toBe(304)
    expect(response.headers.get("ETag")).toBe(etag)
    expect(await response.text()).toBe("")
  }
  const mismatch = await workerFetch(
    ctx,
    new Request(paste.url, {
      headers: {
        "If-None-Match": '"other"',
        "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString(),
      },
    }),
  )
  expect(mismatch.status).toBe(200)
  expect(await mismatch.text()).toBe("hello")
  const metadata = await workerFetch(ctx, addRole(paste.url, "m"))
  expect(metadata.headers.get("ETag")).not.toBe(etag)
  expect(
    (
      await workerFetch(
        ctx,
        new Request(addRole(paste.url, "m"), {
          headers: { "If-None-Match": metadata.headers.get("ETag")! },
        }),
      )
    ).status,
  ).toBe(304)
})

it("does not let conditional requests bypass read limits or revive exhausted pastes", async () => {
  const ctx = createExecutionContext()
  const paste = await upload(ctx, { c: "once", reads: "1" })
  const headers = { "If-None-Match": "*", "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() }
  const first = await workerFetch(ctx, new Request(paste.url, { headers }))
  expect(first.status).toBe(200)
  expect(first.headers.get("Cache-Control")).toBe("no-store")
  expect(await first.text()).toBe("once")
  for (const url of [paste.url, addRole(paste.url, "m"), addRole(paste.url, "d")]) {
    for (const method of ["GET", "HEAD"]) {
      expect((await workerFetch(ctx, new Request(url, { method, headers }))).status).toBe(404)
    }
  }
})
