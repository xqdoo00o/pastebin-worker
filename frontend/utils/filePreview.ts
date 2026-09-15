import mime from "mime"
import { BINARY_MIME_TYPE, MAX_P2P_AUTO_PREVIEW_BYTES, TEXT_MIME_TYPE } from "../../shared/constants.js"
import { decodeUtf8, hasBinaryMarker, hasBinaryMarkerBytes } from "../../shared/encoding.js"
import { mimeEssence } from "../../shared/fileType.js"

export type MediaKind = "image" | "audio" | "video"

export type ReceivedPreview =
  | { kind: "image" | "audio" | "video"; contentType: string }
  | { kind: "text"; contentType: string; text: string }
  | { kind: "deferred-text"; contentType: string }
  | { kind: "download"; contentType: string }

export interface ReceivedBlobClassification {
  preview: ReceivedPreview
  /** Present when a small text file was already read for classification. */
  bytes?: Uint8Array<ArrayBuffer>
  encoding: "UTF-8" | null
}

const MEDIA_EXTENSION_PATTERNS: Readonly<Record<MediaKind, RegExp>> = {
  image: /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i,
  audio: /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i,
  video: /\.(mp4|webm|mov|mkv|avi|m4v|ogv)$/i,
}

export function isDisallowedPasteMime(contentType: string, configuredDisallowed: readonly string[] = []): boolean {
  const essence = mimeEssence(contentType)
  return essence.length > 0 && configuredDisallowed.some((item) => mimeEssence(item) === essence)
}

export function mediaKindOfType(contentType: string): MediaKind | null {
  const normalized = mimeEssence(contentType)
  if (normalized.startsWith("image/")) return "image"
  if (normalized.startsWith("audio/")) return "audio"
  if (normalized.startsWith("video/")) return "video"
  return null
}

/** Match the regular/P2P receiver: trust the declared type first, then use
 * its small, deliberately supported set of common media extensions. */
export function mediaKindOfFile(file: Pick<File, "name" | "type">): MediaKind | null {
  const declaredKind = mediaKindOfType(file.type)
  if (declaredKind) return declaredKind
  for (const kind of ["image", "audio", "video"] as const) {
    if (MEDIA_EXTENSION_PATTERNS[kind].test(file.name)) return kind
  }
  return null
}

/** SVG uploads are served as text/plain to prevent active document rendering.
 * Restore the image MIME only for the isolated object URL used by <img>. */
export function mediaPreviewBlob(file: File): Blob {
  if (/\.svg$/i.test(file.name) && mimeEssence(file.type) !== "image/svg+xml") {
    return new Blob([file], { type: "image/svg+xml" })
  }
  return file
}

/** Mirrors the regular receiver's automatic-preview policy without coupling
 * the standalone camera entry to React. Media can render at any supported
 * size; text is opened automatically only below the same 1 MiB limit. */
export function classifyReceivedFile(
  name: string,
  declaredType: string,
  bytes: Uint8Array,
  configuredDisallowed: readonly string[] = [],
): ReceivedPreview {
  return classifyReceivedBytes(name, declaredType, bytes, configuredDisallowed, ["image", "audio", "video"])
}

function classifyReceivedBytes(
  name: string,
  declaredType: string,
  bytes: Uint8Array,
  configuredDisallowed: readonly string[],
  autoPreviewMedia: readonly MediaKind[],
): ReceivedPreview {
  const isDisallowed = isDisallowedPasteMime(declaredType, configuredDisallowed)
  const contentType = isDisallowed ? TEXT_MIME_TYPE : mimeEssence(declaredType) || BINARY_MIME_TYPE
  const media = isDisallowed ? null : mediaKindOfFile({ name, type: contentType })
  if (media && autoPreviewMedia.includes(media)) return { kind: media, contentType }

  if (bytes.length < MAX_P2P_AUTO_PREVIEW_BYTES) {
    const text = hasBinaryMarkerBytes(bytes) ? null : decodeUtf8(bytes)
    if (text !== null) return { kind: "text", contentType, text }
    return { kind: "download", contentType }
  }

  return contentType.startsWith("text/") ? { kind: "deferred-text", contentType } : { kind: "download", contentType }
}

/** Classify a Blob-backed transfer once, retaining bytes already read for a
 * small text preview. Large unknown files only read the binary-sniff prefix. */
export async function classifyReceivedBlob(
  file: File,
  configuredDisallowed: readonly string[] = [],
  autoPreviewMedia: readonly MediaKind[] = ["image", "audio", "video"],
): Promise<ReceivedBlobClassification> {
  const isDisallowed = isDisallowedPasteMime(file.type, configuredDisallowed)
  const declaredType = isDisallowed ? TEXT_MIME_TYPE : file.type
  const media = isDisallowed ? null : mediaKindOfFile({ name: file.name, type: declaredType })
  if (media && autoPreviewMedia.includes(media)) {
    return { preview: { kind: media, contentType: mimeEssence(declaredType) || BINARY_MIME_TYPE }, encoding: null }
  }

  if (file.size < MAX_P2P_AUTO_PREVIEW_BYTES) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const preview = classifyReceivedBytes(file.name, declaredType, bytes, [], isDisallowed ? [] : autoPreviewMedia)
    return {
      preview,
      bytes: preview.kind === "text" ? bytes : undefined,
      encoding: preview.kind === "text" ? "UTF-8" : null,
    }
  }

  const inferredType = isDisallowed ? TEXT_MIME_TYPE : mime.getType(file.name)
  if (inferredType) {
    return {
      preview: inferredType.startsWith("text/")
        ? { kind: "deferred-text", contentType: inferredType }
        : { kind: "download", contentType: inferredType },
      encoding: null,
    }
  }

  const isBinary = await hasBinaryMarker(file)
  return {
    preview: isBinary
      ? { kind: "download", contentType: BINARY_MIME_TYPE }
      : { kind: "deferred-text", contentType: TEXT_MIME_TYPE },
    encoding: null,
  }
}

/** Classify a disk-backed result without reading it back into the JS heap.
 * Media can use its object URL directly; text stays opt-in and is decoded only
 * if the user requests a preview. */
export function classifyStoredReceivedFile(
  file: Pick<File, "name" | "type">,
  configuredDisallowed: readonly string[] = [],
): ReceivedPreview {
  const isDisallowed = isDisallowedPasteMime(file.type, configuredDisallowed)
  const contentType = isDisallowed ? TEXT_MIME_TYPE : mimeEssence(file.type) || BINARY_MIME_TYPE
  const media = isDisallowed ? null : mediaKindOfFile({ name: file.name, type: contentType })
  if (media) return { kind: media, contentType }
  return contentType.startsWith("text/") ? { kind: "deferred-text", contentType } : { kind: "download", contentType }
}

export function decodeReceivedText(bytes: Uint8Array): string {
  const text = decodeUtf8(bytes)
  if (text === null) throw new TypeError("The received file is not valid UTF-8.")
  return text
}
