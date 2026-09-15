import { Marked, type Token, type Tokens } from "marked"
import GithubSlugger from "github-slugger"
import filterXSS from "xss"
import type { IFilterXSSOptions } from "xss"

import { escapeHtml } from "../common.js"
import { lineNumberText } from "../../shared/format.js"
import manifest from "../../dist/frontend/.vite/ssr-manifest.json"
import { getAssetPaths, renderCssLinks, renderModulePreloadLinks } from "../ssrUtils.js"

// Marked emits whatever HTML the markdown asked for, including raw <script>,
// event handlers, javascript: URLs, etc. Run its output through xss with an
// explicit allowlist of the tags + attributes marked actually produces, so any
// other element from inline HTML is stripped or escaped.
//
// Spelled out rather than spreading xss.getDefaultWhiteList() to:
//  - Avoid CJS/ESM interop fragility under @cloudflare/vitest-pool-workers
//    (the named `FilterXSS` constructor and `getDefaultWhiteList` helper
//    aren't always reachable; only the default-exported `filterXSS()`
//    function survives unmolested).
//  - Stay tighter than the upstream default, which permits a bunch of tags
//    (audio, video, details, font, ...) that markdown never emits.
const sanitizerOptions: IFilterXSSOptions = {
  whiteList: {
    // Headings carry `id` for the TOC + anchor-link target.
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    h5: ["id"],
    h6: ["id"],
    // Header-anchor links use `class` + `aria-label`; normal markdown links
    // use `target` + `href` + `title`. `rel` is allowlisted so the
    // `forceNoopener` hook below can attach `rel="noopener noreferrer"` to
    // any `target="_blank"` link (tabnabbing defence — even though modern
    // browsers default to noopener since Chrome 88 / Firefox 79, older
    // engines, embedded webviews, and crawlers may not).
    a: ["target", "href", "title", "class", "aria-label", "rel"],
    // `src` allows `data:image/*` including `data:image/svg+xml`. Browsers
    // run SVG in "image mode" when loaded via `<img>` — script execution,
    // event handlers, external links, and JS are all disabled by the SVG
    // image-mode spec, and have been across Chrome/Firefox/Safari for years.
    // The remaining risks are privacy (referrer leak via inline `<image
    // href>`) and the user choosing to open the data URL in a new tab — both
    // out of our threat model for now. Matches the prior remark/rehype
    // implementation's behaviour, which also passed `data:` URLs through.
    img: ["src", "alt", "title", "width", "height", "loading"],
    // Block structure.
    p: [],
    br: [],
    hr: [],
    blockquote: [],
    pre: ["class"],
    // Fenced code blocks render as <code class="language-X">.
    code: ["class"],
    // Inline emphasis & friends.
    strong: [],
    em: [],
    s: [],
    del: [],
    ins: [],
    sub: [],
    sup: [],
    mark: [],
    kbd: [],
    abbr: ["title"],
    // The fenced code-block layout uses `<div class="code-block">` as a grid
    // container and `<span class="line-number-rows" aria-hidden>` for the
    // gutter. The class names are server-controlled, so allowing `class` is
    // safe (xss escapes attribute values regardless).
    div: ["class"],
    span: ["class", "aria-hidden"],
    // Lists.
    ul: [],
    ol: ["start"],
    li: [],
    // GFM tables.
    table: [],
    thead: [],
    tbody: [],
    tfoot: [],
    tr: [],
    th: ["align"],
    td: ["align"],
    // GFM task lists.
    input: ["type", "checked", "disabled"],
  },
  // For these tags also drop the body (default behavior is to escape just the
  // wrapping tag, leaving inner text visible — ugly when the body is JS/CSS).
  stripIgnoreTagBody: ["script", "style"],
}

// Attach `rel="noopener noreferrer"` to every `<a target="_blank">` that came
// through sanitization without one. Defence in depth against tabnabbing for
// older browsers / webviews / crawlers that don't default to noopener.
function forceNoopener(html: string): string {
  return html.replace(/<a\b([^>]*\btarget="_blank"[^>]*)>/g, (m, attrs: string) => {
    if (/\brel="[^"]*"/.test(attrs)) return m
    return `<a${attrs} rel="noopener noreferrer">`
  })
}

function sanitizeHtml(html: string): string {
  return forceNoopener(filterXSS(html, sanitizerOptions))
}

const descriptionLimit = 200
const defaultTitle = "Untitled"
const TOC_MIN_DEPTH = 2
const TOC_MAX_DEPTH = 4
const TOC_THRESHOLD = 3

interface TocEntry {
  depth: number
  text: string
  id: string
}

interface DocMetadata {
  title: string
  description: string
  toc: TocEntry[]
}

// Recursively concatenate the text content of a token tree. Equivalent to
// mdast-util-to-string for the cases we care about.
function tokenText(token: Token): string {
  if (token.type === "list") {
    const list = token as Tokens.List
    return list.items.map(tokenText).join("")
  }
  if ("tokens" in token && Array.isArray(token.tokens)) {
    return token.tokens.map(tokenText).join("")
  }
  if ("text" in token && typeof token.text === "string") return token.text
  return ""
}

function firstContentToken(tokens: Token[]): Token | undefined {
  return tokens.find((t) => t.type !== "space")
}

function extractMetadata(tokens: Token[], result: DocMetadata): void {
  const first = firstContentToken(tokens)
  if (!first) return
  if (first.type === "heading" && (first as Tokens.Heading).depth === 1) {
    result.title = escapeHtml(tokenText(first))
    const rest = tokens.slice(tokens.indexOf(first) + 1)
    const second = firstContentToken(rest)
    if (second) result.description = escapeHtml(tokenText(second).slice(0, descriptionLimit))
  } else {
    result.description = escapeHtml(tokenText(first).slice(0, descriptionLimit))
  }
}

function renderToc(toc: TocEntry[]): string {
  const filtered = toc.filter((h) => h.depth >= TOC_MIN_DEPTH && h.depth <= TOC_MAX_DEPTH)
  if (filtered.length < TOC_THRESHOLD) return ""

  const openDepths: number[] = []
  let html = ""

  for (const entry of filtered) {
    while (openDepths.length > 0 && openDepths[openDepths.length - 1] > entry.depth) {
      html += "</li></ol>"
      openDepths.pop()
    }
    const top = openDepths[openDepths.length - 1]
    if (top === entry.depth) {
      html += "</li>"
    } else {
      html += "<ol>"
      openDepths.push(entry.depth)
    }
    html += `<li><a href="#${entry.id}">${escapeHtml(entry.text)}</a>`
  }
  while (openDepths.length > 0) {
    html += "</li></ol>"
    openDepths.pop()
  }

  return `<nav class="toc" aria-label="Table of contents">${html}</nav>`
}

const scrollSpyScript = `
(() => {
  const links = new Map();
  document.querySelectorAll('.toc a[href^="#"]').forEach((a) => {
    links.set(decodeURIComponent(a.getAttribute('href').slice(1)), a);
  });
  if (!links.size) return;
  const headings = [];
  links.forEach((_, id) => {
    const el = document.getElementById(id);
    if (el) headings.push(el);
  });
  if (!headings.length) return;
  let active = null;
  let lockUntil = 0;
  const setActive = (link) => {
    if (link === active) return;
    if (active) active.classList.remove('active');
    if (link) link.classList.add('active');
    active = link;
  };
  const update = () => {
    if (Date.now() < lockUntil) return;
    const threshold = 80;
    let current = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= threshold) current = h;
      else break;
    }
    if (!current) current = headings[0];
    setActive(links.get(current.id));
  };
  const setActiveByHash = () => {
    if (!location.hash) return false;
    const id = decodeURIComponent(location.hash.slice(1));
    const link = links.get(id);
    if (!link) return false;
    setActive(link);
    lockUntil = Date.now() + 800;
    return true;
  };
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; update(); });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  window.addEventListener('hashchange', setActiveByHash);
  if (!setActiveByHash()) update();
})();
`

// Tokenize `$$...$$` blocks and `$...$` spans BEFORE marked's default rules
// see them — otherwise marked treats backslashes (`\\`, `\,`) as escapes and
// eats the LaTeX, then the page hands MathJax mangled input. We pass the math
// through unchanged inside MathJax-recognized `\(...\)` / `\[...\]` delimiters
// so the CDN-loaded MathJax picks it up with its default config.
const mathBlockExt = {
  name: "mathBlock",
  level: "block" as const,
  start(src: string): number | undefined {
    const m = /^[ \t]*\$\$/m.exec(src)
    return m?.index
  },
  tokenizer(src: string) {
    const m = /^[ \t]*\$\$\r?\n([\s\S]+?)\r?\n[ \t]*\$\$(?:\r?\n|$)/.exec(src)
    if (!m) return undefined
    return { type: "mathBlock", raw: m[0], math: m[1] }
  },
  renderer(token: { math: string }) {
    return `<div class="math math-display">\\[${escapeHtml(token.math)}\\]</div>\n`
  },
}

const mathInlineExt = {
  name: "mathInline",
  level: "inline" as const,
  start(src: string): number | undefined {
    const i = src.indexOf("$")
    return i < 0 ? undefined : i
  },
  tokenizer(src: string) {
    // Open `$`, non-empty content with no `$` or newline inside, close `$`
    // not followed by a digit (so "$5 USD = $5" isn't mis-parsed as math).
    const m = /^\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\d)/.exec(src)
    if (!m) return undefined
    return { type: "mathInline", raw: m[0], math: m[1] }
  },
  renderer(token: { math: string }) {
    return `\\(${escapeHtml(token.math)}\\)`
  },
}

export function makeMarkdown(content: string): string {
  const metadata: DocMetadata = { title: defaultTitle, description: "", toc: [] }
  const slugger = new GithubSlugger()

  const marked = new Marked({ gfm: true })
  marked.use({
    extensions: [mathBlockExt, mathInlineExt],
    renderer: {
      heading(this, { tokens, depth }: Tokens.Heading) {
        const innerHtml = this.parser.parseInline(tokens)
        const plainText = tokens.map(tokenText).join("")
        const id = slugger.slug(plainText)
        metadata.toc.push({ depth, text: plainText, id })
        return (
          `<h${depth} id="${id}">` +
          `<a class="header-anchor" aria-label="Permalink to ${escapeHtml(plainText)}" href="#${id}">#</a>` +
          innerHtml +
          `</h${depth}>\n`
        )
      },

      // Fenced code blocks render with a server-side line-number gutter, so
      // the layout is final before highlight.js loads. highlight.js's
      // `highlightElement(<code>)` later swaps the code's children but leaves
      // the sibling `.line-number-rows` untouched.
      code({ text, lang }: Tokens.Code) {
        // Match marked's default normalization: trim trailing newlines, add
        // exactly one back, so the line count matches what's rendered.
        const body = text.replace(/\n+$/, "") + "\n"
        const lineCount = body.match(/\n/g)?.length ?? 1
        const gutter = lineNumberText(lineCount)
        const lang0 = /^\S*/.exec(lang || "")?.[0] || ""
        const classAttr = lang0 ? ` class="language-${escapeHtml(lang0)}"` : ""
        return (
          `<div class="code-block">` +
          `<span class="line-number-rows" aria-hidden="true">${gutter}</span>` +
          `<pre><code${classAttr}>${escapeHtml(body)}</code></pre>` +
          `</div>\n`
        )
      },
    },
  })

  const tokens = marked.lexer(content)
  extractMetadata(tokens, metadata)
  const convertedHtml = sanitizeHtml(marked.parser(tokens))

  const tocHtml = renderToc(metadata.toc)
  const hasToc = tocHtml.length > 0
  const { jsFile, jsPreloadPaths, cssPaths } = getAssetPaths(manifest, "pages/render/markdown.ts")

  return `<!DOCTYPE html>
<html lang='en' class='light'>
<head>
  <meta charset='utf-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1, shrink-to-fit=no'>
  <title>${metadata.title}</title>
  ${metadata.description.length > 0 ? `<meta name='description' content='${metadata.description}'>` : ""}
  <link rel='stylesheet' href='https://pages.github.com/assets/css/style.css'>
  ${renderCssLinks(cssPaths)}
  ${renderModulePreloadLinks(jsPreloadPaths)}
  <script id="MathJax-script" async
          src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js">
  </script>
  <script type='module' src='/${jsFile}'></script>
</head>
<body>
<div class='page${hasToc ? " has-toc" : ""}'>
${tocHtml}
<article class='markdown-body'>
${convertedHtml}
</article>
</div>
  ${hasToc ? `<script>${scrollSpyScript}</script>` : ""}
</body>
</html>
`
}
