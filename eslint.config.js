// @ts-check

import eslint from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  globalIgnores([
    "dist/**",
    ".wrangler/**",
    "codecs/.tools/**",
    "codecs/*/.bench/**",
    "codecs/*/build*/**",
    "codecs/*/dist*/**",
    "codecs/*/third_party/**",
    "frontend/optical/codec/**",
    "frontend/optical/nanorq-codec/**",
    "frontend/wasm/xxhash/**",
    "frontend/wasm/zstd/**",
    "coverage/**",
    "scripts/**",
    "worker-configuration.d.ts",
  ]),
  {
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
    },
  },
  {
    files: ["frontend/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["codecs/**/*.mjs", "codecs/argon2/src/*.js", "codecs/*/src/*.d.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        TextEncoder: "readonly",
        WebAssembly: "readonly",
        fetch: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["codecs/zstd/benchmark*.mjs"],
    languageOptions: {
      globals: {
        URLSearchParams: "readonly",
        WebSocket: "readonly",
        crossOriginIsolated: "readonly",
        document: "readonly",
        location: "readonly",
        navigator: "readonly",
        performance: "readonly",
        setTimeout: "readonly",
      },
    },
  },
)
