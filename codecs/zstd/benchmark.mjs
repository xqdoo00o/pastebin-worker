import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, isAbsolute, join, resolve, sep } from "node:path"

const projectRoot = resolve(import.meta.dirname, "../..")
const candidateRoot = resolve(projectRoot, "frontend/wasm/zstd")
const browserScript = resolve(import.meta.dirname, "benchmark-page.mjs")
const options = parseOptions(process.argv.slice(2))

function parseOptions(args) {
  const result = { baseline: candidateRoot, sizeMiB: 128, samples: 5 }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    if (flag === "--baseline") result.baseline = resolve(value)
    else if (flag === "--size-mib") result.sizeMiB = Number(value)
    else if (flag === "--samples") result.samples = Number(value)
    else throw new Error(`Unknown argument: ${flag}`)
  }
  if (!Number.isInteger(result.sizeMiB) || result.sizeMiB < 16 || result.sizeMiB > 512) {
    throw new Error("--size-mib must be an integer from 16 through 512")
  }
  if (!Number.isInteger(result.samples) || result.samples < 3 || result.samples > 20) {
    throw new Error("--samples must be an integer from 3 through 20")
  }
  return result
}

function chromePath() {
  const configured = process.env.ZSTD_BENCHMARK_BROWSER
  const candidates = [
    configured,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean)
  const found = candidates.find((path) => isAbsolute(path) && existsSync(path))
  if (!found) throw new Error("Set ZSTD_BENCHMARK_BROWSER to a Chromium browser executable")
  return found
}

function contentType(path) {
  switch (extname(path)) {
    case ".js":
    case ".mjs":
      return "text/javascript;charset=UTF-8"
    case ".wasm":
      return "application/wasm"
    default:
      return "application/octet-stream"
  }
}

function safeFile(root, relative) {
  const path = resolve(root, relative)
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Invalid benchmark asset path")
  return path
}

async function serveFile(response, path) {
  try {
    const bytes = await readFile(path)
    response.writeHead(200, { "Content-Type": contentType(path) })
    response.end(bytes)
  } catch {
    response.writeHead(404)
    response.end("not found")
  }
}

const delay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

async function devtoolsPort(profile) {
  const path = join(profile, "DevToolsActivePort")
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(path, "utf8")).split(/\r?\n/)
      if (port) return Number(port)
    } catch {
      // Chrome creates the file after its browser process is ready.
    }
    await delay(50)
  }
  throw new Error("Timed out waiting for the Chromium DevTools endpoint")
}

async function connectDevtools(url) {
  const socket = new WebSocket(url)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true })
    socket.addEventListener("error", () => reject(new Error("Could not connect to Chromium DevTools")), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  return {
    call(method, params = {}) {
      const id = nextId++
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      socket.close()
    },
  }
}

async function runBenchmarkInChrome(profile, url) {
  const browser = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  )
  const browserClosed = new Promise((resolvePromise) => browser.once("close", resolvePromise))
  try {
    const port = await devtoolsPort(profile)
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = pages.find((candidate) => candidate.type === "page")
    if (!page?.webSocketDebuggerUrl) throw new Error("Chromium exposed no debuggable page")
    const devtools = await connectDevtools(page.webSocketDebuggerUrl)
    try {
      await devtools.call("Page.enable")
      await devtools.call("Page.navigate", { url })
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const response = await devtools.call("Runtime.evaluate", {
          expression: 'document.querySelector("#result")?.textContent || ""',
          returnByValue: true,
        })
        const value = response.result?.value
        if (value) return JSON.parse(value)
        await delay(100)
      }
      throw new Error("Timed out waiting for the browser benchmark")
    } finally {
      await devtools.call("Browser.close").catch(() => undefined)
      devtools.close()
    }
  } finally {
    if (browser.exitCode === null) browser.kill()
    await browserClosed
  }
}

async function cleanupProfile(profile) {
  const expectedPrefix = resolve(tmpdir(), "pastebin-zstd-benchmark-")
  if (!resolve(profile).startsWith(expectedPrefix)) {
    throw new Error(`Refusing to clean unexpected profile path: ${profile}`)
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) throw error
      await delay(100 * (attempt + 1))
    }
  }
}

const server = createServer((request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp")
  const url = new URL(request.url, "http://localhost")
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html;charset=UTF-8" })
    response.end('<!doctype html><pre id="result"></pre><script type="module" src="/benchmark-page.mjs"></script>')
  } else if (url.pathname === "/benchmark-page.mjs") {
    void serveFile(response, browserScript)
  } else if (url.pathname.startsWith("/baseline/")) {
    void serveFile(response, safeFile(options.baseline, url.pathname.slice("/baseline/".length)))
  } else if (url.pathname.startsWith("/candidate/")) {
    void serveFile(response, safeFile(candidateRoot, url.pathname.slice("/candidate/".length)))
  } else {
    response.writeHead(404)
    response.end("not found")
  }
})

await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise))
const address = server.address()
if (!address || typeof address === "string") throw new Error("Benchmark server did not bind a TCP port")
const profile = await mkdtemp(join(tmpdir(), "pastebin-zstd-benchmark-"))
try {
  const query = new URLSearchParams({
    baseline: "/baseline",
    candidate: "/candidate",
    sizeMiB: String(options.sizeMiB),
    samples: String(options.samples),
  })
  const result = await runBenchmarkInChrome(profile, `http://127.0.0.1:${address.port}/?${query}`)
  if (result.error) throw new Error(result.error)
  console.log(JSON.stringify(result, null, 2))
} finally {
  server.close()
  await cleanupProfile(profile)
}
