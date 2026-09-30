import { assertPastePassword, requirePasteMetadata } from "../pasteAccess.js"
import { deletePaste } from "../storage/storage.js"
import { parsePath } from "../../shared/parsers.js"

export async function handleDelete(request: Request, env: Env, _: ExecutionContext) {
  const url = new URL(request.url)
  const { name, password } = parsePath(url.pathname)
  const metadata = await requirePasteMetadata(env, name)
  assertPastePassword(name, password, metadata)
  await deletePaste(env, name, metadata)
  return new Response("the paste will be deleted in seconds")
}
