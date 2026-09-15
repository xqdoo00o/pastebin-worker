import { describe, expect, it } from "vitest"
import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from "../encoding.js"

describe("base64 byte helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const source = Uint8Array.from([0, 1, 2, 127, 128, 254, 255])
    expect(base64ToBytes(bytesToBase64(source))).toEqual(source)
  })

  it("emits unpadded URL-safe keys", () => {
    const source = Uint8Array.from([251, 255, 239, 250])
    const encoded = bytesToBase64Url(source)

    expect(encoded).not.toMatch(/[+/=]/)
    expect(base64UrlToBytes(encoded)).toEqual(source)
  })
})
