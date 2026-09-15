import { filenameExtension } from "../../shared/fileType.js"
import { isChromiumBrowser, type NavigatorUserAgentLike } from "./browser.js"

// Keep direct text shares below a conservative cross-platform UTF-16 length;
// larger previews share their file instead.
export const MAX_WEB_SHARE_TEXT_LENGTH = 64 * 1024

export function shouldShareTextAsFile(text: string): boolean {
  return text.length > MAX_WEB_SHARE_TEXT_LENGTH
}

// Mirrors Chromium's Web Share allowlists:
// https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/webshare/share_service_impl.cc
const CHROMIUM_WEB_SHARE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "css",
  "csv",
  "ehtml",
  "flac",
  "gif",
  "htm",
  "html",
  "ico",
  "jfif",
  "jpeg",
  "jpg",
  "m4a",
  "m4v",
  "mp3",
  "mp4",
  "mpeg",
  "mpg",
  "oga",
  "ogg",
  "ogm",
  "ogv",
  "opus",
  "pdf",
  "pjp",
  "pjpeg",
  "png",
  "shtm",
  "shtml",
  "svg",
  "svgz",
  "text",
  "tif",
  "tiff",
  "txt",
  "wav",
  "weba",
  "webm",
  "webp",
  "xbm",
])

const CHROMIUM_WEB_SHARE_MIME_TYPES = new Set([
  "application/pdf",
  "audio/flac",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/webp",
  "image/x-icon",
  "image/x-ms-bmp",
  "image/x-xbitmap",
  "text/comma-separated-values",
  "text/css",
  "text/csv",
  "text/html",
  "text/plain",
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/webm",
])

/** Applies the filename and MIME checks performed by Chromium's native share service. */
export function isChromiumWebShareFileAllowed(file: Pick<File, "name" | "type">): boolean {
  const extensionAllowed = CHROMIUM_WEB_SHARE_EXTENSIONS.has(filenameExtension(file.name))
  return extensionAllowed && CHROMIUM_WEB_SHARE_MIME_TYPES.has(file.type)
}

/** Adds browser-specific checks that navigator.canShare() can miss. */
export function isFileShareAllowedByBrowser(
  file: Pick<File, "name" | "type">,
  navigatorLike: NavigatorUserAgentLike = navigator,
): boolean {
  return !isChromiumBrowser(navigatorLike) || isChromiumWebShareFileAllowed(file)
}
