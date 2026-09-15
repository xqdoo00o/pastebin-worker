import { env } from "cloudflare:test"

import { expect } from "vitest"
import crypto from "crypto"

import worker from "../index.js"
import type { PasteResponse } from "../../shared/interfaces.js"
import { DEFAULT_EDIT_FILENAME } from "../../shared/constants.js"

export const BASE_URL: string = env.DEPLOY_URL
export const RAND_NAME_REGEX = /^[ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678]+$/

export const staticPages = [
  "",
  "index.html",
  "index",
  "index.md",
  "doc/tos",
  "doc/tos.html",
  "doc/tos.md",
  "doc/api",
  "doc/api.html",
  "doc/api.md",
  "doc/curl",
  "doc/curl.html",
  "doc/curl.md",
  "doc/skill",
  "doc/skill.html",
  "doc/skill.md",
  "favicon.ico",
]

type FormDataBuild = Record<string, string | Blob | { content: Blob; filename: string }>

interface UploadRequestOptions {
  method?: "POST" | "PUT"
  url?: string
  headers?: Record<string, string>
  context?: string
}

export async function workerFetch(ctx: ExecutionContext, req: Request | string) {
  // we are not using SELF.fetch since it sometimes do not print worker log to console
  // return await SELF.fetch(req, options)
  return await worker.fetch(new Request(req), env, ctx)
}

async function sendUploadRequest(
  ctx: ExecutionContext,
  kv: FormDataBuild,
  options: UploadRequestOptions,
): Promise<Response> {
  return await workerFetch(
    ctx,
    new Request(options.url || BASE_URL, {
      method: options.method || "POST",
      body: createFormData(kv),
      headers: options.headers || {},
    }),
  )
}

async function throwUnexpectedUploadResponse(response: Response, context?: string): Promise<never> {
  let message = await response.text()
  if (context) message += ` ${context}`
  throw new Error(message)
}

export async function upload(
  ctx: ExecutionContext,
  kv: FormDataBuild,
  options: UploadRequestOptions = {},
): Promise<PasteResponse> {
  const uploadResponse = await sendUploadRequest(ctx, kv, options)
  if (uploadResponse.status !== 200) {
    await throwUnexpectedUploadResponse(uploadResponse, options.context)
  }
  expect(uploadResponse.headers.get("Content-Type")).toStrictEqual("application/json;charset=UTF-8")
  return JSON.parse(await uploadResponse.text()) as PasteResponse
}

export async function uploadExpectStatus(
  ctx: ExecutionContext,
  kv: FormDataBuild,
  expectedStatus: number,
  options: UploadRequestOptions = {},
): Promise<void> {
  const uploadResponse = await sendUploadRequest(ctx, kv, options)
  if (uploadResponse.status !== expectedStatus) {
    await throwUnexpectedUploadResponse(uploadResponse, options.context)
  }
}

function createFormData(kv: FormDataBuild): FormData {
  const fd = new FormData()
  Object.entries(kv).forEach(([k, v]) => {
    if (typeof v === "string") {
      fd.set(k, v)
    } else if (v instanceof Blob) {
      fd.set(k, v, DEFAULT_EDIT_FILENAME) // fd.set automatically sets filename to k, not what we want for content.
    } else {
      // hack for typing
      const { content, filename } = v
      fd.set(k, content, filename)
    }
  })
  return fd
}

export function genRandomBlob(len: number): Blob {
  const buf = new Uint8Array(len)
  const chunkSize = 4096
  for (let i = 0; i < len; i += chunkSize) {
    const fillLen = Math.min(len - i, chunkSize)
    crypto.randomFillSync(buf, i, fillLen)
  }
  return new Blob([buf])
}

export async function areBlobsEqual(blob1: Blob, blob2: Blob) {
  if (blob1.size !== blob2.size) {
    return false
  }
  const array1 = await blob1.bytes()
  const array2 = await blob2.bytes()
  for (let i = 0; i < blob1.size; i++) {
    if (array1[i] != array2[i]) {
      return false
    }
  }
  return true
}

// replace https://example.com/xxx to https://example.com/${role}/xxx
export function addRole(url: string, role: string): string {
  const splitPoint = env.DEPLOY_URL.length
  return url.slice(0, splitPoint) + "/" + role + url.slice(splitPoint)
}
