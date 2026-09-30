import { expect, it } from "vitest"
import { pickPublicEnv } from "../interfaces.js"

it("exposes only public settings, excluding authentication and future private variables", () => {
  const publicSettings = pickPublicEnv({
    DEPLOY_URL: "https://example.test",
    INDEX_PAGE_TITLE: "Pastebin",
    BASIC_AUTH: { privateUser: "private-password-hash" },
    CF_TURN_API_SECRET: "private-turn-secret",
    TURN_SHARED_SECRET: "private-coturn-secret",
    FUTURE_SECRET: "private-future-value",
  } as unknown as Env)
  expect(publicSettings.DEPLOY_URL).toBe("https://example.test")
  expect(publicSettings.INDEX_PAGE_TITLE).toBe("Pastebin")
  expect(JSON.stringify(publicSettings)).not.toContain("private-")
  for (const key of ["BASIC_AUTH", "CF_TURN_API_SECRET", "TURN_SHARED_SECRET", "FUTURE_SECRET"])
    expect(publicSettings).not.toHaveProperty(key)
})
