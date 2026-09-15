import { WorkerError } from "./common.js"
import { ParseError } from "../shared/parsers.js"

import { ALLOW_HEADER, handleOptions, corsWrapResponse } from "./handlers/handleCors.js"
import { handlePostOrPut } from "./handlers/handleWrite.js"
import { handleGet } from "./handlers/handleRead.js"
import { handleDelete } from "./handlers/handleDelete.js"
import { cleanExpiredInR2 } from "./storage/storage.js"
import { P2PRoom, handleP2PRequest } from "./p2p.js"
import { PasteReadCounter } from "./readCounter.js"

export { P2PRoom, PasteReadCounter }

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx)
  },

  scheduled(controller: ScheduledController, env, ctx): Promise<void> {
    ctx.waitUntil(cleanExpiredInR2(env, controller))
    return Promise.resolve()
  },
} satisfies ExportedHandler<Env>

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    if (request.method === "OPTIONS") {
      return handleOptions(request)
    } else {
      const response = await handleNormalRequest(request, env, ctx)
      if (response.webSocket || response.status === 101) {
        return response
      }
      if (response.status !== 302 && response.status !== 404 && response.headers !== undefined) {
        // because Cloudflare do not allow modifying redirect headers
        response.headers.set("Access-Control-Allow-Origin", "*")
      }
      return response
    }
  } catch (e) {
    if (e instanceof ParseError) {
      return corsWrapResponse(new Response(`Error 400: ${e.message}\n`, { status: 400 }))
    } else if (e instanceof WorkerError) {
      return corsWrapResponse(
        new Response(`Error ${e.statusCode}: ${e.message}\n`, {
          status: e.statusCode,
          headers: e.statusCode === 401 ? { "Cache-Control": "private, no-store" } : undefined,
        }),
      )
    } else {
      const err = e as Error
      console.error(err.stack)
      return corsWrapResponse(new Response(`Error 500: ${err.message}\n`, { status: 500 }))
    }
  }
}

async function handleNormalRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Keep the normal paste hot path free from P2P URL parsing and async calls.
  if (request.url.includes("/p2p/")) {
    const p2pResponse = await handleP2PRequest(request, env)
    if (p2pResponse !== null) return p2pResponse
  }

  switch (request.method) {
    case "POST":
      return handlePostOrPut(request, env, ctx, false)
    case "GET":
      return handleGet(request, env, ctx, false)
    case "HEAD":
      return handleGet(request, env, ctx, true)
    case "DELETE":
      return handleDelete(request, env, ctx)
    case "PUT":
      return handlePostOrPut(request, env, ctx, true)
    default:
      return new Response(`method ${request.method} not allowed`, {
        status: 405,
        headers: { Allow: ALLOW_HEADER },
      })
  }
}
