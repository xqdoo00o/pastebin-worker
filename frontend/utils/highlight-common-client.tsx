import type { ReactNode } from "react"
import hljs from "highlight.js/lib/common"
import { HljsHookProvider, LanguagesProvider } from "./highlight.js"

const languages = hljs.listLanguages().sort()
const useHLJS = (lang: string | undefined) => (lang && hljs.getLanguage(lang) ? hljs : undefined)

/** Common-language highlighting for the offline optical receiver. */
export function HljsProvider({ children }: { children: ReactNode }) {
  return (
    <HljsHookProvider value={useHLJS}>
      <LanguagesProvider value={languages}>{children}</LanguagesProvider>
    </HljsHookProvider>
  )
}
