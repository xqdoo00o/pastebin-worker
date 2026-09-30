import { BINARY_SNIFF_BYTES } from "./constants.js"

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true })

// Optional native APIs: the fallback remains usable on older browsers.
type Base64Bytes = Uint8Array & {
  toBase64?: (options?: { alphabet?: "base64url"; omitPadding?: boolean }) => string
}
const base64Constructor = Uint8Array as Uint8ArrayConstructor & {
  fromBase64?: (value: string) => Uint8Array<ArrayBuffer>
}

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
  const native = (bytes as Base64Bytes).toBase64
  if (native) return native.call(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  if (base64Constructor.fromBase64) return base64Constructor.fromBase64(encoded)
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  const native = (bytes as Base64Bytes).toBase64
  if (native) return native.call(bytes, { alphabet: "base64url", omitPadding: true })
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
