import { timingSafeEqual, WorkerError } from "./common.js"
import { getPasteMetadata, getRemainingReads, hasReadLimit, type PasteMetadata } from "./storage/storage.js"

export async function requirePasteMetadata(env: Env, name: string): Promise<PasteMetadata> {
  const metadata = await getPasteMetadata(env, name)
  if (metadata === null || (hasReadLimit(metadata) && (await getRemainingReads(env, name, metadata)) === null)) {
    throw new WorkerError(404, `paste of name ‘${name}’ is not found`)
  }
  return metadata
}

export function assertPastePassword(name: string, password: string | undefined, metadata: PasteMetadata): void {
  if (!timingSafeEqual(password, metadata.passwd)) {
    throw new WorkerError(403, `incorrect password for paste ‘${name}’`)
  }
}
