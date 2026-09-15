export interface NavigatorUserAgentLike {
  userAgent: string
  userAgentData?: {
    brands?: readonly { brand: string; version: string }[]
  }
}

/** Detects Chromium-family browsers without treating Chrome on iOS as Chromium. */
export function isChromiumBrowser(navigatorLike: NavigatorUserAgentLike = navigator): boolean {
  if (navigatorLike.userAgentData?.brands?.some(({ brand }) => /^(?:Chromium|Google Chrome)$/i.test(brand))) {
    return true
  }
  return /\b(?:Chrome|Chromium|HeadlessChrome)\/\d+/i.test(navigatorLike.userAgent)
}

export function browserLabel(userAgent: string | undefined): string {
  if (!userAgent) return "Unknown browser"
  const rules: [RegExp, string][] = [
    [/Edg\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+).*Safari\//, "Safari"],
  ]
  for (const [regex, name] of rules) {
    const match = regex.exec(userAgent)
    if (match?.[1]) return `${name} ${match[1]}`
  }
  return "Unknown browser"
}
