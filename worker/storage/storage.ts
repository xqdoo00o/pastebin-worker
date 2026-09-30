import { dateToUnix, genRandStr, workerAssert, WorkerError } from "../common.js"
import { parseSize } from "../../shared/parsers.js"
import type { MetaResponse, OriginalFileInfo, PasteLocation } from "../../shared/interfaces.js"
import { mapWithConcurrency } from "../../shared/async.js"
import { recordPasteAccess } from "./accessCounter.js"
import { newPasteObjectKey, pasteNameFromObjectKey, pasteObjectKey } from "./objectKey.js"
import {
  consumePasteReadState,
  getPasteReadState,
  initializePasteReadState,
  type PasteReadConsumption,
  type PasteReadStateSeed,
} from "../readCounter.js"

// since CF does not allow expiration shorter than 60s, extend the expiration to 70s
const PASTE_EXPIRE_SPECIFIED_MIN = 70
const R2_CLEANUP_KV_LOOKUP_CONCURRENCY = 32
const R2_CLEANUP_GRACE_MS = 5 * 60 * 1000
// Bound KV/R2 subrequests per invocation; cursors resume the next hour.
const R2_CLEANUP_BUCKET_LIST_LIMIT = 128
const R2_CLEANUP_MAX_BUCKET_PAGES = 2
const R2_CLEANUP_QUEUE_LIST_LIMIT = 128
const R2_CLEANUP_MAX_QUEUE_PAGES = 1
const R2_CLEANUP_BUCKET_CURSOR_KEY = "__pb_internal/r2-cleanup-bucket-cursor"
const R2_CLEANUP_QUEUE_CURSOR_KEY = "__pb_internal/r2-cleanup-queue-cursor"
const R2_CLEANUP_QUEUE_PREFIX = "__pb_internal/r2-cleanup/"
const KV_METADATA_MAX_BYTES = 1024

// TODO: allow admin to upload permanent paste
// TODO: add filename length check
export interface PasteMetadata {
  schemaVersion: 1
  location: PasteLocation
  r2Key?: string // present for R2-backed pastes
  cacheVersion: string // changes on every successful publication, including metadata-only changes
  passwd: string

  lastModifiedAtUnix: number
  createdAtUnix: number
  willExpireAtUnix: number

  remainingReads?: number
  readStateVersion?: string
  readStateKey?: string // isolated counter for each read-limited version
  sizeBytes: number
  filename?: string
  filenames?: OriginalFileInfo[]
  mimeType?: string
  highlightLanguage?: string
  encryptionScheme?: string
}

interface PasteMetadataInStorage extends PasteMetadata {
  extendedMetadataInValue?: true
}

type ExtendedPasteMetadata = Pick<
  PasteMetadata,
  "filename" | "filenames" | "mimeType" | "highlightLanguage" | "encryptionScheme"
>

export function metaResponseFromMetadata(metadata: PasteMetadata): MetaResponse {
  return {
    lastModifiedAt: new Date(metadata.lastModifiedAtUnix * 1000).toISOString(),
    createdAt: new Date(metadata.createdAtUnix * 1000).toISOString(),
    expireAt: new Date(metadata.willExpireAtUnix * 1000).toISOString(),
    sizeBytes: metadata.sizeBytes,
    location: metadata.location,
    remainingReads: metadata.remainingReads,
    filename: metadata.filename,
    filenames: metadata.filenames,
    mimeType: metadata.mimeType,
    highlightLanguage: metadata.highlightLanguage,
    encryptionScheme: metadata.encryptionScheme,
  }
}

function serializedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function metadataFitsInKv(metadata: PasteMetadata): boolean {
  return serializedByteLength(metadata) <= KV_METADATA_MAX_BYTES
}

function extendedMetadata(metadata: ExtendedPasteMetadata): ExtendedPasteMetadata {
  return {
    filename: metadata.filename,
    filenames: metadata.filenames,
    mimeType: metadata.mimeType,
    highlightLanguage: metadata.highlightLanguage,
    encryptionScheme: metadata.encryptionScheme,
  }
}

function compactR2Metadata(metadata: PasteMetadata): PasteMetadataInStorage {
  const {
    filename: _filename,
    filenames: _filenames,
    mimeType: _mimeType,
    highlightLanguage: _highlightLanguage,
    encryptionScheme: _encryptionScheme,
    ...compact
  } = metadata
  const stored: PasteMetadataInStorage = { ...compact, extendedMetadataInValue: true }
  workerAssert(
    serializedByteLength(stored) <= KV_METADATA_MAX_BYTES,
    "internal paste metadata exceeds the Workers KV metadata limit",
  )
  return stored
}

async function metadataFromStorage(original: PasteMetadataInStorage, value: ReadableStream): Promise<PasteMetadata> {
  if (!original.extendedMetadataInValue) return original
  if (original.location !== "R2") {
    throw new WorkerError(500, "invalid paste metadata storage layout")
  }

  let extended: Partial<ExtendedPasteMetadata>
  try {
    const parsed: unknown = await new Response(value).json()
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("extended metadata is not an object")
    }
    extended = parsed
  } catch (error) {
    console.warn("Failed to parse extended paste metadata:", error instanceof Error ? error.message : error)
    throw new WorkerError(500, "invalid extended paste metadata")
  }
  return { ...original, ...extendedMetadata(extended) }
}

async function putPasteIndex(
  env: Env,
  pasteName: string,
  kvContent: ArrayBuffer | ReadableStream,
  metadata: PasteMetadata,
  expiration: number,
): Promise<void> {
  if (metadataFitsInKv(metadata)) {
    await env.PB.put(pasteName, metadata.location === "R2" ? "" : kvContent, { metadata, expiration })
    return
  }

  if (metadata.location === "R2") {
    await env.PB.put(pasteName, JSON.stringify(extendedMetadata(metadata)), {
      metadata: compactR2Metadata(metadata),
      expiration,
    })
    return
  }

  workerAssert(false, "inline paste metadata exceeds the Workers KV metadata limit")
}

export interface PasteRecord {
  metadata: PasteMetadata
  kvBody: ReadableStream | null
}

export interface PasteBody {
  paste: ReadableStream
}

export interface PasteBodyRange {
  offset: number
  length: number
}

async function cancelUnusedStream(stream: ReadableStream): Promise<void> {
  try {
    await stream.cancel()
  } catch {
    // The stream may already be closed or cancelled by the runtime.
  }
}

export async function discardPasteRecord(record: PasteRecord): Promise<void> {
  const stream = record.kvBody
  record.kvBody = null
  if (stream) await cancelUnusedStream(stream)
}

export async function getPasteRecord(env: Env, short: string, ctx: ExecutionContext): Promise<PasteRecord | null> {
  const item = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, {
    type: "stream",
  })

  if (item.value === null) {
    return null
  }

  if (item.metadata === null) {
    await cancelUnusedStream(item.value)
    throw new WorkerError(500, `paste of name '${short}' has no metadata`)
  }
  const metadata = await metadataFromStorage(item.metadata, item.value)
  if (metadata.willExpireAtUnix < Date.now() / 1000) {
    await cancelUnusedStream(item.value)
    ctx.waitUntil(cleanupPasteVersion(env, metadata))
    return null
  }

  if (metadata.location === "R2" && !item.metadata.extendedMetadataInValue) await cancelUnusedStream(item.value)

  return {
    metadata,
    kvBody: metadata.location === "KV" ? item.value : null,
  }
}

export async function openPasteBody(
  env: Env,
  short: string,
  record: PasteRecord,
  ctx: ExecutionContext,
  range?: PasteBodyRange,
): Promise<PasteBody | null> {
  if (record.metadata.location === "R2") {
    const object = await env.R2.get(pasteObjectKey(record.metadata), range ? { range } : undefined)
    if (object === null) return null
    if (!hasReadLimit(record.metadata) && Math.random() < 0.01) {
      ctx.waitUntil(recordPasteAccess(env, short, record.metadata))
    }
    return { paste: object.body }
  }

  workerAssert(record.kvBody !== null, `KV body of paste '${short}' has already been opened`)
  const paste = record.kvBody
  record.kvBody = null
  if (!hasReadLimit(record.metadata) && Math.random() < 0.01) {
    ctx.waitUntil(recordPasteAccess(env, short, record.metadata))
  }
  return { paste }
}

// Metadata-only callers intentionally do not update the access metric.
export async function getPasteMetadata(env: Env, short: string): Promise<PasteMetadata | null> {
  const item = await env.PB.getWithMetadata<PasteMetadataInStorage>(short, {
    type: "stream",
  })

  if (item.value === null) {
    return null
  }
  try {
    if (item.metadata === null) {
      throw new WorkerError(500, `paste of name '${short}' has no metadata`)
    }
    if (item.metadata.willExpireAtUnix < new Date().getTime() / 1000) {
      return null
    }
    return await metadataFromStorage(item.metadata, item.value)
  } finally {
    await cancelUnusedStream(item.value)
  }
}

interface WriteOptions {
  now: Date
  contentLength: number
  expirationSeconds: number
  passwd: string
  filename?: string
  filenames?: OriginalFileInfo[]
  mimeType?: string
  highlightLanguage?: string
  encryptionScheme?: string
  remainingReads?: number
  isMPUComplete: boolean
  r2Key?: string
}

export function hasReadLimit(metadata: PasteMetadata): boolean {
  return metadata.remainingReads !== undefined
}

function readStateSeed(metadata: PasteMetadata): PasteReadStateSeed {
  workerAssert(metadata.remainingReads !== undefined, "cannot create a read state seed without a read limit")
  workerAssert(metadata.readStateVersion !== undefined, "read-limited paste has no counter version")
  return {
    version: metadata.readStateVersion,
    remainingReads: metadata.remainingReads,
    expiresAt: metadata.willExpireAtUnix * 1000,
  }
}

export async function consumeRead(env: Env, pasteName: string, metadata: PasteMetadata): Promise<PasteReadConsumption> {
  workerAssert(metadata.readStateKey !== undefined, `read-limited paste '${pasteName}' has no counter key`)
  return await consumePasteReadState(env, metadata.readStateKey, readStateSeed(metadata))
}

export async function getRemainingReads(env: Env, pasteName: string, metadata: PasteMetadata): Promise<number | null> {
  workerAssert(metadata.readStateKey !== undefined, `read-limited paste '${pasteName}' has no counter key`)
  const snapshot = await getPasteReadState(env, metadata.readStateKey, readStateSeed(metadata))
  return snapshot.available ? snapshot.remainingReads : null
}

interface PasteMetadataSeed {
  location: PasteLocation
  createdAtUnix: number
  readStateVersion?: string
  readStateKey?: string
}

function choosePasteLocation(env: Env, options: WriteOptions, currentLocation?: PasteLocation): PasteLocation {
  return currentLocation === "R2" || options.isMPUComplete || options.contentLength > parseSize(env.R2_THRESHOLD)!
    ? "R2"
    : "KV"
}

function buildPasteMetadata(options: WriteOptions, seed: PasteMetadataSeed): PasteMetadata {
  const nowUnix = dateToUnix(options.now)
  const metadata: PasteMetadata = {
    schemaVersion: 1,
    location: seed.location,
    cacheVersion: crypto.randomUUID(),
    filename: options.filename,
    filenames: options.filenames,
    mimeType: options.mimeType,
    highlightLanguage: options.highlightLanguage,
    passwd: options.passwd,
    lastModifiedAtUnix: nowUnix,
    createdAtUnix: seed.createdAtUnix,
    willExpireAtUnix: nowUnix + options.expirationSeconds,
    remainingReads: options.remainingReads,
    readStateVersion: seed.readStateVersion,
    readStateKey: seed.readStateKey,
    sizeBytes: options.contentLength,
    encryptionScheme: options.encryptionScheme,
  }

  // KV metadata is capped at 1024 serialized bytes. Moving an oversized
  // inline paste to R2 lets the index keep only the compact metadata.
  return metadata.location === "KV" && !metadataFitsInKv(metadata) ? { ...metadata, location: "R2" } : metadata
}

async function persistPaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  metadata: PasteMetadata,
  options: WriteOptions,
  readState?: PasteReadStateSeed,
): Promise<void> {
  if (metadata.location === "R2") {
    workerAssert(!options.isMPUComplete || options.r2Key !== undefined, "completed MPU has no object key")
    metadata.r2Key = options.r2Key ?? newPasteObjectKey(pasteName)
  }
  try {
    if (readState !== undefined) {
      // Prepare an independent counter. Failures below leave the live version intact.
      await initializePasteReadState(env, metadata.readStateKey!, readState)
    }
    if (metadata.location === "R2" && !options.isMPUComplete) {
      await env.R2.put(metadata.r2Key!, content, {
        customMetadata: { willExpireAtUnix: String(metadata.willExpireAtUnix) },
      })
    }
    const kvExpiration = metadata.lastModifiedAtUnix + Math.max(options.expirationSeconds, PASTE_EXPIRE_SPECIFIED_MIN)
    await putPasteIndex(env, pasteName, content, metadata, kvExpiration)
  } catch (error) {
    // A completed MPU already has an R2 object; a direct write may also have
    // succeeded before KV publication failed. The sweep checks the live index.
    if (metadata.r2Key) await queueR2Cleanup(env, metadata.r2Key)
    throw error
  }
}

function preparePasteWrite(env: Env, pasteName: string, options: WriteOptions, original?: PasteMetadata) {
  const readStateVersion = options.remainingReads !== undefined ? crypto.randomUUID() : undefined
  const metadata = buildPasteMetadata(options, {
    // Updates keep the storage class stable until old immutable versions are swept.
    location: choosePasteLocation(env, options, original?.location),
    createdAtUnix: original?.createdAtUnix ?? dateToUnix(options.now),
    readStateVersion,
    readStateKey: readStateVersion ? `${pasteName}:${readStateVersion}` : undefined,
  })
  const readState: PasteReadStateSeed | undefined = readStateVersion
    ? {
        version: readStateVersion,
        remainingReads: options.remainingReads ?? null,
        expiresAt: metadata.willExpireAtUnix * 1000,
        ...(original ? { cleanupAt: Math.max(original.willExpireAtUnix, metadata.willExpireAtUnix) * 1000 } : {}),
      }
    : undefined
  return { metadata, readState }
}

export async function updatePaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  originalMetadata: PasteMetadata,
  options: WriteOptions,
): Promise<PasteMetadata> {
  const { metadata, readState } = preparePasteWrite(env, pasteName, options, originalMetadata)
  await persistPaste(env, pasteName, content, metadata, options, readState)
  if (originalMetadata.location === "R2") {
    await queueR2Cleanup(env, pasteObjectKey(originalMetadata))
  }

  // Retire only after KV publication succeeds. A failed cleanup must not report
  // a successfully committed write as failed. Counter alarms bound its lifetime.
  try {
    await retireReadState(env, pasteName, originalMetadata)
  } catch (error) {
    console.warn("Failed to retire previous paste read state", error)
  }

  return metadata
}

export async function createPaste(
  env: Env,
  pasteName: string,
  content: ArrayBuffer | ReadableStream,
  options: WriteOptions,
): Promise<PasteMetadata> {
  const { metadata, readState } = preparePasteWrite(env, pasteName, options)
  await persistPaste(env, pasteName, content, metadata, options, readState)

  return metadata
}

export async function pasteNameAvailable(env: Env, pasteName: string): Promise<boolean> {
  const item = await env.PB.getWithMetadata<PasteMetadata>(pasteName)
  if (item.value === null) return true
  if (item.metadata === null) throw new WorkerError(500, `paste of name '${pasteName}' has no metadata`)
  return (
    item.metadata.willExpireAtUnix < Date.now() / 1000 ||
    (hasReadLimit(item.metadata) && (await getRemainingReads(env, pasteName, item.metadata)) === null)
  )
}

interface RandomPasteNameOptions {
  maxAttempts?: number
  generateName?: (length: number) => string
}

export async function allocateRandomPasteName(
  env: Env,
  length: number,
  options: RandomPasteNameOptions = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 30
  const generateName = options.generateName ?? genRandStr

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateName(length)
    if (await pasteNameAvailable(env, candidate)) return candidate
  }

  throw new WorkerError(503, "unable to allocate an unused paste name")
}

async function retireReadState(env: Env, pasteName: string, metadata: PasteMetadata): Promise<void> {
  if (metadata.remainingReads !== undefined || metadata.readStateVersion !== undefined) {
    workerAssert(metadata.readStateKey !== undefined, `read-limited paste '${pasteName}' has no counter key`)
    await initializePasteReadState(env, metadata.readStateKey, {
      version: `deleted:${crypto.randomUUID()}`,
      remainingReads: null,
      expiresAt: Date.now(),
      cleanupAt: metadata.willExpireAtUnix * 1000,
    })
  }
}

async function queueR2Cleanup(env: Env, objectKey: string): Promise<void> {
  try {
    await env.PB.put(`${R2_CLEANUP_QUEUE_PREFIX}${objectKey}`, "", { metadata: { queuedAtMs: Date.now() } })
  } catch (error) {
    // The bucket scan still reclaims the object once its own expiration passes.
    console.warn("Failed to queue R2 object cleanup", error)
  }
}

// Reader-triggered cleanup must never delete the mutable name index: KV has no
// compare-and-delete, and another request may already have published a new version.
// The counter denies exhausted reads; KV expiration removes the old index/body.
export async function cleanupPasteVersion(env: Env, metadata: PasteMetadata): Promise<void> {
  if (metadata.location === "R2" && metadata.r2Key) await env.R2.delete(metadata.r2Key)
}

export async function deletePaste(env: Env, pasteName: string, originalMetadata: PasteMetadata): Promise<void> {
  // Commit the index deletion before retiring the read counter. If KV rejects
  // the delete, both the body and its read allowance remain usable. Leave R2
  // bytes in place for stale KV readers in other locations; the sweep reclaims
  // the unreferenced object after its grace period.
  await env.PB.delete(pasteName)
  if (originalMetadata.location === "R2") {
    await queueR2Cleanup(env, pasteObjectKey(originalMetadata))
  }
  try {
    await retireReadState(env, pasteName, originalMetadata)
  } catch (error) {
    // The index is already gone. A failed counter cleanup must not turn a
    // committed deletion into a retryable error.
    console.warn("Failed to retire deleted paste read state", error)
  }
}

async function readCleanupCursor(env: Env, key: string): Promise<string | undefined> {
  return (await env.PB.get(key)) ?? undefined
}

async function saveCleanupCursor(env: Env, key: string, previous: string | undefined, next: string | undefined) {
  if (next) await env.PB.put(key, next)
  else if (previous) await env.PB.delete(key)
}

async function cleanQueuedR2Objects(env: Env, nowMs: number): Promise<number> {
  const previous = await readCleanupCursor(env, R2_CLEANUP_QUEUE_CURSOR_KEY)
  let cursor = previous
  let cleaned = 0
  for (let page = 0; page < R2_CLEANUP_MAX_QUEUE_PAGES; page++) {
    const listed = await env.PB.list<{ queuedAtMs: number }>({
      prefix: R2_CLEANUP_QUEUE_PREFIX,
      cursor,
      limit: R2_CLEANUP_QUEUE_LIST_LIMIT,
    })
    const ready = listed.keys.filter(
      (entry) =>
        typeof entry.metadata?.queuedAtMs === "number" && entry.metadata.queuedAtMs <= nowMs - R2_CLEANUP_GRACE_MS,
    )
    const removed = await mapWithConcurrency(ready, R2_CLEANUP_KV_LOOKUP_CONCURRENCY, async (entry) => {
      const objectKey = entry.name.slice(R2_CLEANUP_QUEUE_PREFIX.length)
      const pasteName = pasteNameFromObjectKey(objectKey)
      const live = pasteName === null ? null : await getPasteMetadata(env, pasteName)
      if (live?.location === "R2" && pasteObjectKey(live) === objectKey) return false
      await env.R2.delete(objectKey)
      await env.PB.delete(entry.name)
      return true
    })
    cleaned += removed.filter(Boolean).length
    cursor = listed.list_complete ? undefined : listed.cursor
    if (!cursor) break
  }
  await saveCleanupCursor(env, R2_CLEANUP_QUEUE_CURSOR_KEY, previous, cursor)
  return cleaned
}

export async function cleanExpiredInR2(env: Env, controller: ScheduledController) {
  const nowUnix = controller.scheduledTime / 1000
  let numCleaned = await cleanQueuedR2Objects(env, controller.scheduledTime)

  const previous = await readCleanupCursor(env, R2_CLEANUP_BUCKET_CURSOR_KEY)
  let cursor = previous
  for (let page = 0; page < R2_CLEANUP_MAX_BUCKET_PAGES; page++) {
    const listed = await env.R2.list({ cursor, limit: R2_CLEANUP_BUCKET_LIST_LIMIT, include: ["customMetadata"] })
    const toDelete: string[] = []

    // A completed MPU can be listed before its KV index is committed/visible.
    // Leave recent writes for a later sweep, including abandoned completions.
    const needKvLookup: R2Object[] = []
    for (const obj of listed.objects) {
      if (obj.uploaded.getTime() > controller.scheduledTime - R2_CLEANUP_GRACE_MS) continue
      const expStr = obj.customMetadata?.willExpireAtUnix
      // Direct uploads with a future expiration do not need a daily KV read.
      // Replaced/deleted versions are handled by the explicit queue above.
      if (!expStr || !Number.isFinite(Number(expStr)) || Number(expStr) < nowUnix) {
        needKvLookup.push(obj)
      }
    }

    // KV owns the final expiration; MPU objects carry no expiration metadata.
    const kvResults = await mapWithConcurrency(needKvLookup, R2_CLEANUP_KV_LOOKUP_CONCURRENCY, (obj) => {
      const name = pasteNameFromObjectKey(obj.key)
      return name === null ? Promise.resolve(null) : getPasteMetadata(env, name)
    })
    for (let i = 0; i < needKvLookup.length; i++) {
      const kvMeta = kvResults[i]
      if (
        kvMeta === null ||
        kvMeta.willExpireAtUnix < nowUnix ||
        kvMeta.location !== "R2" ||
        pasteObjectKey(kvMeta) !== needKvLookup[i].key
      ) {
        toDelete.push(needKvLookup[i].key)
      }
    }

    if (toDelete.length > 0) {
      await env.R2.delete(toDelete)
      numCleaned += toDelete.length
    }

    cursor = listed.truncated ? listed.cursor : undefined
    if (!cursor) break
  }

  await saveCleanupCursor(env, R2_CLEANUP_BUCKET_CURSOR_KEY, previous, cursor)
  console.log(`${numCleaned} R2 objects cleaned`)
}
