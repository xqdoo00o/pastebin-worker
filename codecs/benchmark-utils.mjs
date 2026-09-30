export function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

/** Deterministic noise, optionally repeating a prefix to model compressible data. */
export function benchmarkBytes(length, repeatBytes = 0) {
  const bytes = new Uint8Array(length)
  let state = 0x9e3779b9
  for (let index = 0; index < length; index++) {
    if (repeatBytes > 0 && index >= repeatBytes) bytes[index] = bytes[index % repeatBytes]
    else {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      bytes[index] = state
    }
  }
  return bytes
}
