// Already-entropy-coded file detection, shared by the QR optical protocol
// (skip zstd) and the ZIP archive writer (store instead of deflate/zstd).

import { filenameExtension, mimeEssence } from "../../shared/fileType.js"

const PRECOMPRESSED_TYPES = new Set([
  "application/gzip",
  "application/java-archive",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-brotli",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-lzma",
  "application/x-rar-compressed",
  "application/x-xz",
  "application/x-zip-compressed",
  "application/zip",
  "application/zstd",
  "font/woff",
  "font/woff2",
])

const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/
const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/

/** Skip a full compression pass for formats that are already entropy-coded. */
export function isPrecompressedType(type: string): boolean {
  const media = mimeEssence(type)
  if (media.startsWith("video/")) return true
  if (media.startsWith("image/")) return !COMPRESSIBLE_IMAGES.test(media)
  if (media.startsWith("audio/")) return !COMPRESSIBLE_AUDIO.test(media)
  if (media.startsWith("application/vnd.openxmlformats-officedocument.")) return true
  if (media.startsWith("application/vnd.oasis.opendocument.")) return true
  if (media.endsWith("+zip")) return true
  return PRECOMPRESSED_TYPES.has(media)
}

const PRECOMPRESSED_EXTENSIONS = new Set([
  "7z",
  "aac",
  "avi",
  "avif",
  "br",
  "bz2",
  "docx",
  "epub",
  "flac",
  "gif",
  "gz",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "ogg",
  "ogv",
  "opus",
  "pdf",
  "png",
  "pptx",
  "rar",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xlsx",
  "xz",
  "zip",
  "zst",
])

/** True when a file should be stored rather than compressed: either its MIME
 * type is already entropy-coded, or its extension marks a compressed format
 * (used as a fallback when the MIME type is generic or empty). */
export function isPrecompressedFile(file: File): boolean {
  return isPrecompressedType(file.type) || PRECOMPRESSED_EXTENSIONS.has(filenameExtension(file.name))
}
