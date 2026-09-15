import { describe, expect, it } from "vitest"
import {
  dedupeFilename,
  highlightLanguageFromMimeType,
  inferHighlightLanguage,
  withHighlightLanguage,
} from "../fileType.js"

describe("dedupeFilename", () => {
  it("keeps an available filename", () => {
    expect(dedupeFilename("report.txt", () => false)).toBe("report.txt")
  })

  it("increments a suffix while preserving the extension", () => {
    const existing = new Set(["report.txt", "report (2).txt"])
    expect(dedupeFilename("report.txt", (candidate) => existing.has(candidate))).toBe("report (3).txt")
  })

  it("handles extensionless and dot-prefixed names", () => {
    expect(dedupeFilename("README", (candidate) => candidate === "README")).toBe("README (2)")
    expect(dedupeFilename(".env", (candidate) => candidate === ".env")).toBe(".env (2)")
  })
})

describe("inferHighlightLanguage", () => {
  it("maps JavaScript and TypeScript file variants", () => {
    expect(inferHighlightLanguage("script.js")).toBe("javascript")
    expect(inferHighlightLanguage("module.MJS")).toBe("javascript")
    expect(inferHighlightLanguage("component.tsx")).toBe("typescript")
  })

  it("handles special code filenames and ignores unknown extensions", () => {
    expect(inferHighlightLanguage("services/api/Dockerfile")).toBe("dockerfile")
    expect(inferHighlightLanguage("archive.bin")).toBeUndefined()
  })
})

describe("highlight language MIME metadata", () => {
  it("round-trips a language while preserving existing MIME parameters", () => {
    const type = withHighlightLanguage("text/plain; charset=utf-8", "JavaScript")
    expect(type).toBe("text/plain; charset=utf-8; x-pb-highlight=javascript")
    expect(highlightLanguageFromMimeType(type)).toBe("javascript")
  })

  it("replaces an existing hint and preserves an explicit plaintext choice", () => {
    const type = withHighlightLanguage("text/plain; x-pb-highlight=javascript", "plaintext")
    expect(type).toBe("text/plain; x-pb-highlight=plaintext")
    expect(highlightLanguageFromMimeType(type)).toBe("plaintext")
  })

  it("uses a binary essence for files without a declared media type", () => {
    const type = withHighlightLanguage("", "dockerfile")
    expect(type).toBe("application/octet-stream; x-pb-highlight=dockerfile")
    expect(highlightLanguageFromMimeType(type)).toBe("dockerfile")
  })

  it("ignores invalid hints", () => {
    expect(withHighlightLanguage("text/plain", "bad language")).toBe("text/plain")
    expect(highlightLanguageFromMimeType("text/plain; x-pb-highlight=bad language")).toBeUndefined()
  })
})
