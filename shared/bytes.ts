/** Return an ArrayBuffer-backed view over the same bytes when possible.
 * SharedArrayBuffer is not accepted by every Web API that consumes a
 * BufferSource/BlobPart, so that uncommon input is copied once. */
export function asArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Uint8Array.from(bytes)
}

/** Return an owned buffer that can be transferred without including bytes
 * outside the view. A full ArrayBuffer-backed view is reused without copying. */
export function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer
  }
  return bytes.slice().buffer
}
