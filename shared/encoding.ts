import { BINARY_SNIFF_BYTES } from "./constants.js"

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true })

const HTML_ESCAPE_REPLACEMENTS: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE_REPLACEMENTS[character])
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/")
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
}

export function hasBinaryMarkerBytes(content: Uint8Array): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

export async function hasBinaryMarker(content: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await content.slice(0, BINARY_SNIFF_BYTES).arrayBuffer())
  return hasBinaryMarkerBytes(bytes)
}

/** Decode valid UTF-8 once, returning null instead of retaining a discarded
 * validation string and decoding the same bytes again at the call site. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return fatalUtf8Decoder.decode(bytes)
  } catch {
    return null
  }
}

// Returns "UTF-8" if the bytes are valid UTF-8 (which subsumes pure ASCII), null otherwise.
// Used to decide whether a paste should render as text or be treated as a binary download.
//
// This is a deliberate simplification of full charset detection: legacy single-byte encodings
// (ISO-8859-1, Windows-1252, etc.) are reported as binary. UTF-8 is universal enough today
// that the regression is acceptable, and the user can still force-render via the UI.
export function detectUtf8(bytes: Uint8Array): "UTF-8" | null {
  return decodeUtf8(bytes) === null ? null : "UTF-8"
}
