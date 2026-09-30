import type { PasteMetadata } from "./storage.js"

function counterKey(name: string, metadata: PasteMetadata): string {
  // Slashes reserve a namespace that cannot be allocated as a paste name.
  return `access/${name}/${metadata.createdAtUnix}`
}

/** A sampled, approximate metric. It must never write the paste's own KV key. */
export async function getAccessCounter(env: Env, name: string, metadata: PasteMetadata): Promise<number> {
  const value = await env.PB.get(counterKey(name, metadata))
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

export async function recordPasteAccess(env: Env, name: string, metadata: PasteMetadata): Promise<void> {
  try {
    if (metadata.willExpireAtUnix <= Date.now() / 1000) return
    const count = await getAccessCounter(env, name, metadata)
    await env.PB.put(counterKey(name, metadata), String(Math.min(count + 1, Number.MAX_SAFE_INTEGER)), {
      expiration: Math.max(metadata.willExpireAtUnix, Math.floor(Date.now() / 1000) + 70),
    })
  } catch (error) {
    // Sampling is best-effort; even its failure must not affect the paste.
    if (!(error instanceof Error && error.message.includes("429"))) console.warn("Access counter update failed", error)
  }
}
