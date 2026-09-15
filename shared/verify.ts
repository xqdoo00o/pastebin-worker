import { MAX_PASSWD_LEN, MIN_PASSWD_LEN } from "./constants.js"
import type { OriginalFileInfo } from "./interfaces.js"
import { parseExpiration, parseExpirationReadable } from "./parsers.js"
import { parseNonNegativeSafeInteger } from "./numbers.js"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type VerifyResult = [ok: true, message: string] | [ok: false, error: string]

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value)
}

export function isLegalUrl(url: string): boolean {
  return URL.canParse(url)
}

export function isOriginalFileInfo(value: unknown): value is OriginalFileInfo {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<OriginalFileInfo>
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.sizeBytes === "number" &&
    Number.isSafeInteger(candidate.sizeBytes) &&
    candidate.sizeBytes >= 0
  )
}

export function verifyPassword(password: string): VerifyResult {
  if (password === "") {
    return [true, ""]
  } else if (password.length < MIN_PASSWD_LEN) {
    return [false, `Password too short (${password.length} < ${MIN_PASSWD_LEN})`]
  } else if (password.length > MAX_PASSWD_LEN) {
    return [false, `Password too long (${password.length} > ${MAX_PASSWD_LEN})`]
  } else if (password.includes("\n")) {
    return [false, "Password should not contain newlines"]
  }
  return [true, ""]
}

export function verifyExpiration(expiration: string, maxExpiration: string): VerifyResult {
  const parsed = parseExpiration(expiration)
  if (parsed === null) {
    return [false, `‘${expiration}’ is not a valid expiration specification`]
  }
  const maxExpirationSeconds = parseExpiration(maxExpiration)!
  if (parsed > maxExpirationSeconds) {
    return [false, `Exceed max expiration (${parseExpirationReadable(maxExpiration)!})`]
  }
  return [true, `Expires in ${parseExpirationReadable(expiration)!}`]
}

export function parseReadLimit(readLimit: string | number | null | undefined): number | null {
  return parseNonNegativeSafeInteger(readLimit)
}

interface LimitLabels {
  invalid: string
  unlimited: string
  single: string
  multiple(limit: number): string
}

function verifyLimit(value: string | number, labels: LimitLabels): VerifyResult {
  const parsed = parseReadLimit(value)
  if (parsed === null) return [false, labels.invalid]
  if (parsed === 0) return [true, labels.unlimited]
  if (parsed === 1) return [true, labels.single]
  return [true, labels.multiple(parsed)]
}

export function verifyReadLimit(readLimit: string | number): VerifyResult {
  return verifyLimit(readLimit, {
    invalid: "Reads must be a non-negative integer",
    unlimited: "Unlimited reads",
    single: "Burn after read",
    multiple: (limit) => `${limit} max reads`,
  })
}

export function verifyReceiverLimit(receiverLimit: string | number): VerifyResult {
  return verifyLimit(receiverLimit, {
    invalid: "Transfers must be a non-negative integer",
    unlimited: "Unlimited transfers",
    single: "Stop after transfer",
    multiple: (limit) => `${limit} max transfers`,
  })
}
