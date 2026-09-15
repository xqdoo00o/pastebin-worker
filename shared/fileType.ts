import { BINARY_MIME_TYPE } from "./constants.js"

/** Returns the lowercase final extension without its leading dot. */
export function filenameExtension(name: string): string {
  const base = name.endsWith("/") ? name.slice(0, -1) : name
  const dot = base.lastIndexOf(".")
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** Returns a normalized MIME type without parameters such as charset. */
export function mimeEssence(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase()
}

const HIGHLIGHT_LANGUAGE_MIME_PARAMETER = "x-pb-highlight"
const VALID_HIGHLIGHT_LANGUAGE = /^[a-z0-9][a-z0-9_+.-]{0,63}$/i

/** Adds the optional QR presentation hint without changing the
 * media-type essence. Unknown MIME parameters are ignored by older clients. */
export function withHighlightLanguage(contentType: string, language: string | undefined): string {
  if (!language || !VALID_HIGHLIGHT_LANGUAGE.test(language)) return contentType
  const essence = mimeEssence(contentType) || BINARY_MIME_TYPE
  const parameters = contentType
    .split(";")
    .slice(1)
    .map((parameter) => parameter.trim())
    .filter((parameter) => !parameter.toLowerCase().startsWith(`${HIGHLIGHT_LANGUAGE_MIME_PARAMETER}=`))
  parameters.push(`${HIGHLIGHT_LANGUAGE_MIME_PARAMETER}=${language.toLowerCase()}`)
  return [essence, ...parameters].join("; ")
}

/** Reads the optional syntax-highlight hint carried in a MIME parameter. */
export function highlightLanguageFromMimeType(contentType: string): string | undefined {
  for (const parameter of contentType.split(";").slice(1)) {
    const [rawName, ...rawValueParts] = parameter.trim().split("=")
    if (rawName?.toLowerCase() !== HIGHLIGHT_LANGUAGE_MIME_PARAMETER) continue
    const value = rawValueParts.join("=").trim().replace(/^"|"$/g, "")
    return VALID_HIGHLIGHT_LANGUAGE.test(value) ? value.toLowerCase() : undefined
  }
  return undefined
}

const HIGHLIGHT_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cts: "typescript",
  mts: "typescript",
  ts: "typescript",
  tsx: "typescript",
  htm: "xml",
  html: "xml",
  svg: "xml",
  xhtml: "xml",
  xml: "xml",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  zsh: "bash",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  php: "php",
  css: "css",
  less: "less",
  scss: "scss",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  lua: "lua",
  swift: "swift",
  dart: "dart",
}

/** Infers a highlight.js language from a code filename without reading its contents. */
export function inferHighlightLanguage(filename: string | undefined): string | undefined {
  if (!filename) return undefined
  const pathParts = filename.split(/[\\/]/)
  const basename = pathParts[pathParts.length - 1]?.toLowerCase()
  if (basename === "dockerfile") return "dockerfile"
  if (basename === "makefile") return "makefile"
  return HIGHLIGHT_LANGUAGE_BY_EXTENSION[filenameExtension(filename)]
}

/** Returns a filename that does not collide according to the supplied predicate. */
export function dedupeFilename(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name

  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ""
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`
    if (!exists(candidate)) return candidate
  }
}
