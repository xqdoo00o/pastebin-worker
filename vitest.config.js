import { defineConfig } from "vitest/config"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"

// Workers require Istanbul rather than V8 coverage.
const coverage = {
  provider: "istanbul",
  reporter: ["text", "json-summary", "html", "json"],
  exclude: ["**/test/**"],
}

export default defineConfig({
  test: {
    // Leave enough process capacity for the Workers pool when all projects run together.
    maxWorkers: 4,
    coverage,
    projects: [
      defineConfig({
        plugins: [
          cloudflareTest({
            miniflare: {
              bindings: {
                BASIC_AUTH: {},
              },
            },
            wrangler: {
              configPath: "./wrangler.toml",
            },
          }),
        ],
        test: {
          name: "Workers",
          include: ["worker/test/**/*.spec.ts"],
          // BASIC_AUTH is mutable test state, and password hashing can block
          // unrelated Worker files when the pool runs them in parallel.
          fileParallelism: false,
          coverage,
        },
      }),
      {
        extends: "frontend/vite.config.js",
        test: {
          include: ["frontend/test/**/*.spec.{ts,tsx}"],
          name: "Frontend",
          environment: "jsdom",
          coverage,
        },
      },
      {
        test: {
          include: ["shared/test/**/*.spec.ts"],
          name: "Shared",
          environment: "node",
          coverage,
        },
      },
    ],
  },
})
