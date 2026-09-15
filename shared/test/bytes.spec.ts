import { describe, expect, it } from "vitest"
import { asArrayBufferView, transferableBuffer } from "../bytes.js"

describe("asArrayBufferView", () => {
  it("keeps ArrayBuffer-backed input as a zero-copy view", () => {
    const buffer = new ArrayBuffer(5)
    const source = new Uint8Array(buffer, 1, 3)
    source.set([1, 2, 3])

    const view = asArrayBufferView(source)

    expect(view.buffer).toBe(buffer)
    expect(view.byteOffset).toBe(1)
    expect([...view]).toEqual([1, 2, 3])
  })

  it("copies SharedArrayBuffer-backed input", () => {
    const buffer = new SharedArrayBuffer(4)
    const source = new Uint8Array(buffer, 1, 2)
    source.set([4, 5])

    const view = asArrayBufferView(source)
    source[0] = 9

    expect(view.buffer).toBeInstanceOf(ArrayBuffer)
    expect([...view]).toEqual([4, 5])
  })
})

describe("transferableBuffer", () => {
  it("reuses a full ArrayBuffer-backed view", () => {
    const buffer = new ArrayBuffer(3)

    expect(transferableBuffer(new Uint8Array(buffer))).toBe(buffer)
  })

  it("copies only the bytes in a partial view", () => {
    const source = Uint8Array.from([1, 2, 3, 4]).subarray(1, 3)

    expect([...new Uint8Array(transferableBuffer(source))]).toEqual([2, 3])
  })
})
