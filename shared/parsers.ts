import { PASSWD_SEP } from "./constants.js"

export class ParseError extends Error {
  constructor(msg: string) {
    super(msg)
  }
}

interface ScaledValue<Unit extends string> {
  amount: number
  unit: Unit | ""
  value: number
}

function parseScaledValue<Unit extends string>(
  input: string,
  pattern: RegExp,
  multipliers: Readonly<Record<Unit, number>>,
): ScaledValue<Unit> | null {
  const match = pattern.exec(input.trim())
  if (!match?.[1]) return null
  const amount = Number(match[1])
  const unit = (match[2] ?? "") as Unit | ""
  return { amount, unit, value: amount * (unit === "" ? 1 : multipliers[unit]) }
}

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([KMG]?)$/
const SIZE_MULTIPLIERS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as const
const EXPIRATION_PATTERN = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/
const EXPIRATION_MULTIPLIERS = { s: 1, m: 60, h: 3600, d: 3600 * 24 } as const

export function parseSize(sizeStr: string): number | null {
  return parseScaledValue(sizeStr, SIZE_PATTERN, SIZE_MULTIPLIERS)?.value ?? null
}

export function parseExpiration(expirationStr: string): number | null {
  return parseScaledValue(expirationStr, EXPIRATION_PATTERN, EXPIRATION_MULTIPLIERS)?.value ?? null
}

export function parseExpirationReadable(expirationStr: string): string | null {
  const parsed = parseScaledValue(expirationStr, EXPIRATION_PATTERN, EXPIRATION_MULTIPLIERS)
  if (!parsed) return null
  const noun = parsed.unit === "m" ? "minute" : parsed.unit === "h" ? "hour" : parsed.unit === "d" ? "day" : "second"
  return `${parsed.amount} ${noun}${parsed.amount > 1 ? "s" : ""}`
}

export interface ParsedPath {
  name: string
  role?: string
  password?: string
  ext?: string
  filename?: string
}

export function parsePath(pathname: string): ParsedPath {
  pathname = pathname.slice(1) // strip the leading slash

  let role: string | undefined,
    ext: string | undefined,
    filename: string | undefined,
    passwd: string | undefined,
    short: string | undefined

  // extract and remove role
  if (pathname[1] === "/") {
    role = pathname[0]
    pathname = pathname.slice(2)
  }

  // extract and remove filename
  const startOfFilename = pathname.lastIndexOf("/")
  if (startOfFilename >= 0) {
    filename = decodeURIComponent(pathname.slice(startOfFilename + 1))
    pathname = pathname.slice(0, startOfFilename)
  }

  // if having filename, parse ext from filename, else from remaining pathname
  if (filename) {
    const startOfExt = filename.indexOf(".")
    if (startOfExt >= 0) {
      ext = filename.slice(startOfExt)
    }
  } else {
    const startOfExt = pathname.indexOf(".")
    if (startOfExt >= 0) {
      ext = pathname.slice(startOfExt)
      pathname = pathname.slice(0, startOfExt)
    }
  }

  const endOfShort = pathname.indexOf(PASSWD_SEP)
  if (endOfShort < 0) {
    short = pathname
    passwd = undefined
  } else {
    short = pathname.slice(0, endOfShort)
    passwd = pathname.slice(endOfShort + 1)
  }

  if (!short) {
    throw new ParseError(`invalid path: paste name is empty`)
  }

  return { role, name: short, password: passwd, ext, filename }
}

export function parseFilenameFromContentDisposition(contentDisposition: string): string | undefined {
  let filename: string | undefined = undefined

  const filenameStarRegex = /filename\*=UTF-8''([^;]*)/i
  const filenameStarMatch = filenameStarRegex.exec(contentDisposition)

  if (filenameStarMatch?.[1]) {
    filename = decodeURIComponent(filenameStarMatch[1])
  }

  if (!filename) {
    const filenameRegex = /filename="([^"]*)"/i
    const filenameMatch = filenameRegex.exec(contentDisposition)

    if (filenameMatch?.[1]) {
      filename = filenameMatch[1]
    }
  }

  return filename
}
