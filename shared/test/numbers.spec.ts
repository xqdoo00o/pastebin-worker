import { describe, expect, it } from "vitest"
import { isNonNegativeSafeInteger, parseNonNegativeSafeInteger } from "../numbers.js"

describe("parseNonNegativeSafeInteger", () => {
  it("accepts non-negative safe integer strings and numbers", () => {
    expect(parseNonNegativeSafeInteger("0")).toBe(0)
    expect(parseNonNegativeSafeInteger("42")).toBe(42)
    expect(parseNonNegativeSafeInteger(42)).toBe(42)
  })

  it("rejects missing, fractional, negative, and unsafe values", () => {
    for (const value of [null, undefined, "invalid", "1.5", -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseNonNegativeSafeInteger(value)).toBeNull()
    }
  })
})

describe("isNonNegativeSafeInteger", () => {
  it("narrows only non-negative safe integers", () => {
    expect(isNonNegativeSafeInteger(0)).toBe(true)
    expect(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true)
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(isNonNegativeSafeInteger(value)).toBe(false)
    }
  })
})
