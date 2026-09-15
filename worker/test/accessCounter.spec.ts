import { expect, it, beforeEach, vi, afterEach } from "vitest"
import { genRandomBlob, upload, workerFetch } from "./testUtils.js"
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import type { PasteMetadata } from "../storage/storage.js"

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0)
})

afterEach(() => {
  vi.restoreAllMocks()
})

it("increase access counter", async () => {
  const ctx = createExecutionContext()
  const content = genRandomBlob(1024)
  const response = await upload(ctx, { c: content })
  const url = response.url
  const name = new URL(url).pathname.split("/").filter(Boolean).pop()!

  async function getCounter() {
    const paste = await env.PB.getWithMetadata<PasteMetadata>(name)
    return paste?.metadata?.accessCounter
  }

  expect(await getCounter()).toStrictEqual(0)

  await workerFetch(ctx, url)
  await waitOnExecutionContext(ctx)

  expect(await getCounter()).toStrictEqual(1)

  await workerFetch(ctx, url)
  await waitOnExecutionContext(ctx)

  expect(await getCounter()).toStrictEqual(2)
})
