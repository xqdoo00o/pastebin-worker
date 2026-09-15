/** Parse values such as HTTP Content-Length and transfer limits strictly. */
export function parseNonNegativeSafeInteger(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return isNonNegativeSafeInteger(parsed) ? parsed : null
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
