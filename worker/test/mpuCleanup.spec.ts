import { afterEach, expect, it, vi } from "vitest"
import { createExecutionContext, createScheduledController, env } from "cloudflare:test"
import { BASE_URL, workerFetch } from "./testUtils.js"
import { cleanExpiredInR2 } from "../storage/storage.js"
import type { MPUCreateResponse, PasteResponse } from "../../shared/interfaces.js"

afterEach(() => vi.useRealTimers())

it("keeps MPU data until the completion expiry", async () => {
  vi.useFakeTimers()
  const started = Date.now()
  const ctx = createExecutionContext()
  const created = await workerFetch(ctx, new Request(`${BASE_URL}/mpu/create?e=1h`, { method: "POST" }))
  expect(created.status).toBe(200)
  const upload = await created.json<MPUCreateResponse>()
  const part = await env.R2.resumeMultipartUpload(upload.key, upload.uploadId).uploadPart(1, "data")
  vi.setSystemTime(started + 30 * 60_000)
  const form = new FormData()
  form.set("c", new File([JSON.stringify([part])], "file.bin"))
  form.set("e", "2h")
  const response = await workerFetch(
    ctx,
    new Request(`${BASE_URL}/mpu/complete?name=${upload.name}&key=${upload.key}&uploadId=${upload.uploadId}`, {
      method: "POST",
      body: form,
    }),
  )
  expect(response.status).toBe(200)
  const paste = await response.json<PasteResponse>()
  expect(new Date(paste.expireAt).getTime()).toBeGreaterThan(started + 2 * 60 * 60_000)

  vi.setSystemTime(started + 90 * 60_000)
  await cleanExpiredInR2(env, createScheduledController({ scheduledTime: Date.now() }))
  expect(await env.R2.head(upload.key)).not.toBeNull()
  const body = await workerFetch(ctx, paste.url)
  expect(await body.bytes()).toEqual(new TextEncoder().encode("data"))

  vi.setSystemTime(started + 3 * 60 * 60_000)
  await cleanExpiredInR2(env, createScheduledController({ scheduledTime: Date.now() }))
  expect(await env.R2.head(upload.key)).toBeNull()
})
