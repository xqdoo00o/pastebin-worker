import { atob_utf8, WorkerError } from "../common.js"
import argon2Module from "../../codecs/argon2/dist/argon2_bg.wasm"
import initArgon2, { verify_password_hash } from "../../codecs/argon2/dist/argon2.js"

const AUTH_CACHE_TTL_MS = 5 * 60_000
const AUTH_CACHE_MAX_ENTRIES = 512
const successfulAuthCache = new Map<string, number>()
const encoder = new TextEncoder()

async function authCacheKey(authorization: string, encodedHash: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${encodedHash}\0${authorization}`))
  let key = ""
  for (const byte of new Uint8Array(digest)) key += byte.toString(16).padStart(2, "0")
  return key
}

function hasCachedAuth(key: string, now: number): boolean {
  const expiresAt = successfulAuthCache.get(key)
  if (expiresAt === undefined) return false
  if (expiresAt <= now) {
    successfulAuthCache.delete(key)
    return false
  }
  successfulAuthCache.delete(key)
  successfulAuthCache.set(key, expiresAt)
  return true
}

function cacheSuccessfulAuth(key: string, now: number): void {
  for (const [entry, expiresAt] of successfulAuthCache) {
    if (expiresAt <= now) successfulAuthCache.delete(entry)
  }
  if (successfulAuthCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldest = successfulAuthCache.keys().next().value
    if (oldest !== undefined) successfulAuthCache.delete(oldest)
  }
  successfulAuthCache.set(key, now + AUTH_CACHE_TTL_MS)
}

export async function verifyPasswordHash(password: string, encodedHash: string): Promise<boolean> {
  await initArgon2(argon2Module)
  return verify_password_hash(password, encodedHash)
}

// Decoding function
export function decodeBasicAuth(encodedString: string): {
  username: string
  password: string
} {
  const [scheme, encodedCredentials] = encodedString.split(" ")
  if (scheme !== "Basic") {
    throw new WorkerError(400, "Invalid authentication scheme")
  }
  const credentials = atob_utf8(encodedCredentials)
  const [username, password] = credentials.split(":", 2)
  return { username, password }
}

// return null if auth passes or is not required,
// return auth page if auth is required
// throw WorkerError if auth failed
export async function verifyAuth(request: Request, env: Env): Promise<Response | null> {
  // pass auth if 'BASIC_AUTH' is not present
  const basic_auth = env.BASIC_AUTH as Record<string, string>
  const auth_entries = Object.entries(basic_auth)

  const passwdMap = new Map<string, string>(auth_entries)

  // pass auth if 'BASIC_AUTH' is empty
  if (passwdMap.size === 0) return null

  const authorization = request.headers.get("Authorization")
  if (authorization !== null) {
    const { username, password } = decodeBasicAuth(authorization)
    const encodedHash = passwdMap.get(username)
    if (encodedHash === undefined) {
      throw new WorkerError(401, "incorrect passwd for basic auth")
    }
    const cacheKey = await authCacheKey(authorization, encodedHash)
    if (hasCachedAuth(cacheKey, Date.now())) {
      return null
    }
    if (!(await verifyPasswordHash(password, encodedHash))) {
      throw new WorkerError(401, "incorrect passwd for basic auth")
    }
    cacheSuccessfulAuth(cacheKey, Date.now())
    return null
  } else {
    return new Response("HTTP basic auth is required", {
      status: 401,
      headers: {
        // Prompts the user for credentials.
        "WWW-Authenticate": 'Basic charset="UTF-8"',
        "Cache-Control": "private, no-store",
      },
    })
  }
}
