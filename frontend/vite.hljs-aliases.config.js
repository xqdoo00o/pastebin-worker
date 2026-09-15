import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Exposes highlight.js aliases (for example js -> javascript) to every Vite
 * build that uses the shared lazy language loader. */
export function hljsAliasesPlugin() {
  const virtualId = "virtual:hljs-aliases"
  const resolvedId = `\0${virtualId}`
  return {
    name: "hljs-aliases",
    resolveId: {
      filter: { id: /^virtual:hljs-aliases$/ },
      handler() {
        return resolvedId
      },
    },
    load: {
      filter: { id: /^\0virtual:hljs-aliases$/ },
      handler() {
        const langDir = resolve(import.meta.dirname, "../node_modules/highlight.js/lib/languages")
        const aliases = {}
        for (const file of readdirSync(langDir).sort()) {
          if (!file.endsWith(".js") || file.endsWith(".js.js")) continue
          const canonical = file.slice(0, -3)
          const source = readFileSync(resolve(langDir, file), "utf8")
          // Some modules overwrite a base language's aliases later. Match the
          // final real object property so the map reflects the runtime value.
          const matches = [...source.matchAll(/[,{]\s*aliases:\s*\[([^\]]+)\]/g)]
          if (!matches.length) continue
          for (const raw of matches[matches.length - 1][1].split(",")) {
            const alias = raw.replace(/['"]/g, "").trim()
            if (alias) aliases[alias] = canonical
          }
        }
        return `export default ${JSON.stringify(aliases)}`
      },
    },
  }
}
