import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { URL } from "node:url"

import {
  configuredNinja,
  emsdkLocation,
  emscriptenVersion,
  localCmakeCommand,
  projectRoot,
  readEmscriptenConfig,
  toolOverride,
  toolsDir,
} from "./toolchain.mjs"

const projectDir = projectRoot
const cmakeMetadataPath = join(toolsDir, "cmake.json")
const { configuredBy, configuredSdkDir, sdkDir } = emsdkLocation()
const sdkRepository = "https://github.com/emscripten-core/emsdk.git"
const sdkVersion = emscriptenVersion
const git = toolOverride("GIT").value || "git"
const curl = toolOverride("CURL").value || "curl"
const emcc = toolOverride("EMCC").value || "emcc"
const emcmake = toolOverride("EMCMAKE").value || "emcmake"
const cmakeOverride = toolOverride("CMAKE")
const ninjaOverride = toolOverride("NINJA")
const pythonOverride = toolOverride("PYTHON")

if (process.argv.includes("--help")) {
  console.log(
    "Checks the build tools and installs the latest stable CMake, Ninja, and the pinned Emscripten SDK when needed.",
  )
  process.exit(0)
}
if (process.argv.length !== 2) throw new Error("Usage: node codecs/emscripten/setup.mjs")

function probe(command, args = [], environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  })
  return {
    found: !result.error,
    ok: !result.error && result.status === 0,
    text: `${result.stdout || ""}\n${result.stderr || ""}`.trim(),
  }
}

function numericVersion(text) {
  return text.match(/\d+(?:\.\d+)+/)?.[0]
}

function versionAtLeast(actual, minimum) {
  const left = actual.split(".").map(Number)
  const right = minimum.split(".").map(Number)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

function requireVersionedTool(name, command, args, minimum) {
  const result = probe(command, args)
  if (!result.ok) throw new Error(`${name} was not found on PATH. Install ${name} ${minimum}+ before setup.`)
  const version = numericVersion(result.text)
  if (!version || !versionAtLeast(version, minimum)) {
    throw new Error(`${name} ${minimum}+ is required; found ${version || "an unknown version"}.`)
  }
  console.log(`Found ${name} ${version}`)
}

function versionedTool(command, args, minimum) {
  const result = probe(command, args)
  const version = numericVersion(result.text)
  return {
    command,
    ok: result.ok && Boolean(version) && versionAtLeast(version, minimum),
    version,
  }
}

function availableTool(command, args = ["--version"]) {
  const result = probe(command, args)
  return { command, ok: result.ok, text: result.text }
}

function requireTool(name, command, args = ["--version"]) {
  const result = probe(command, args)
  if (!result.ok) throw new Error(`${name} was not found on PATH. Install it before setup.`)
  console.log(`Found ${result.text.split(/\r?\n/, 1)[0]}`)
}

function firstLine(text) {
  return text.split(/\r?\n/, 1)[0]
}

function exactVersion(result, expected) {
  return result.ok && numericVersion(result.text) === expected
}

function selectCmake() {
  if (cmakeOverride.value) {
    return versionedTool(cmakeOverride.value, ["--version"], "3.16")
  }
  const candidates = [localCmakeCommand(toolsDir), "cmake"].filter(Boolean)
  for (const candidate of candidates) {
    const tool = versionedTool(candidate, ["--version"], "3.16")
    if (tool.ok) return tool
  }
  return versionedTool("cmake", ["--version"], "3.16")
}

async function fetchResponse(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await globalThis.fetch(url, {
        headers: { "User-Agent": "pastebin-worker-emscripten-setup" },
        redirect: "follow",
      })
      if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < 3) console.log(`Retrying ${url} after a download error (${attempt}/3).`)
    }
  }
  throw lastError
}

async function latestStableCmakeVersion() {
  const response = await fetchResponse("https://cmake.org/download/")
  const page = await response.text()
  const match = page.match(/<h2[^>]*id=["']latest["'][^>]*>\s*Latest Release\s*\((\d+\.\d+\.\d+)\)/i)
  if (!match) throw new Error("Cannot determine the latest stable CMake version from https://cmake.org/download/")
  return match[1]
}

async function loadEmsdkManifest() {
  const localManifest = join(sdkDir, "emsdk_manifest.json")
  if (existsSync(localManifest)) return JSON.parse(readFileSync(localManifest, "utf8"))
  const response = await fetchResponse(
    "https://raw.githubusercontent.com/emscripten-core/emsdk/main/emsdk_manifest.json",
  )
  return response.json()
}

function cmakeArchive(version, manifest) {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : undefined
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : undefined
  if (!arch || !os) {
    throw new Error(`Official CMake binaries are not configured for ${process.platform}/${process.arch}`)
  }
  const tool = manifest.tools
    .filter((entry) => entry.id === "cmake" && entry.arch === arch && entry[`url_${os}`])
    .at(-1)
  if (!tool || typeof tool.version !== "string") {
    throw new Error(`emsdk does not define a CMake binary for ${process.platform}/${process.arch}`)
  }

  const template = tool[`url_${os}`]
  if (!template.includes(tool.version)) throw new Error(`The emsdk CMake URL does not contain version ${tool.version}`)
  const url = template.replaceAll(tool.version, version)
  const parsedUrl = new URL(url)
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    !parsedUrl.pathname.startsWith("/Kitware/CMake/releases/download/")
  ) {
    throw new Error(`The emsdk CMake URL is not an official Kitware release: ${url}`)
  }

  const activation = tool[`activated_cfg_${os}`] || tool.activated_cfg
  const configuredPath = activation
    ?.split("=", 2)[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, "")
  if (!configuredPath?.startsWith("%installation_dir%/")) {
    throw new Error("The emsdk CMake entry does not define its executable path")
  }
  const executable = configuredPath
    .slice("%installation_dir%/".length)
    .replaceAll("%.exe%", process.platform === "win32" ? ".exe" : "")
    .split("/")
  return { name: decodeURIComponent(parsedUrl.pathname.split("/").at(-1)), executable, url }
}

async function download(url, destination, fallbackUrl = url) {
  const curlProbe = probe(curl, ["--version"])
  if (curlProbe.ok) {
    const result = spawnSync(
      curl,
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--retry-all-errors",
        "--connect-timeout",
        "30",
        "--output",
        destination,
        url,
      ],
      { cwd: projectDir, env: process.env, stdio: "inherit", windowsHide: true },
    )
    if (!result.error && result.status === 0) return
    console.log(`curl could not download CMake; retrying with Node.js from ${fallbackUrl}`)
  }

  const response = await fetchResponse(fallbackUrl)
  if (!response.body) throw new Error(`Download returned an empty response: ${url}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function sha256(filePath) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest("hex")
}

function writeCmakeMetadata(version, executable) {
  const relativeExecutable = relative(toolsDir, executable).replaceAll("\\", "/")
  writeFileSync(
    cmakeMetadataPath,
    `${JSON.stringify({ version, executable: relativeExecutable, source: "https://cmake.org/download/" }, null, 2)}\n`,
  )
}

async function installLatestCmake() {
  const version = await latestStableCmakeVersion()
  const archive = cmakeArchive(version, await loadEmsdkManifest())
  const installDir = join(toolsDir, "cmake", version)
  const executable = join(installDir, ...archive.executable)
  if (existsSync(executable)) {
    writeCmakeMetadata(version, executable)
    const installed = versionedTool(executable, ["--version"], "3.16")
    if (installed.ok) return installed
  }
  if (existsSync(installDir)) {
    throw new Error(`${installDir} is an incomplete CMake installation; remove it and retry`)
  }

  mkdirSync(toolsDir, { recursive: true })
  const temporaryDir = mkdtempSync(join(toolsDir, ".cmake-download-"))
  const archivePath = join(temporaryDir, archive.name)
  const extractDir = join(temporaryDir, "extract")
  const releaseSeries = version.match(/^\d+\.\d+/)?.[0]
  if (!releaseSeries) throw new Error(`Cannot determine the CMake release series from ${version}`)
  const releaseBase = `https://cmake.org/files/v${releaseSeries}`
  console.log(`CMake 3.16+ was not found; downloading official CMake ${version}.`)
  try {
    mkdirSync(extractDir)
    const checksumName = `cmake-${version}-SHA-256.txt`
    const checksumResponse = await fetchResponse(`${releaseBase}/${checksumName}`)
    const checksums = await checksumResponse.text()
    const expected = checksums
      .split(/\r?\n/)
      .find((line) => line.endsWith(`  ${archive.name}`))
      ?.split(/\s+/, 1)[0]
    if (!expected || !/^[a-f\d]{64}$/i.test(expected)) {
      throw new Error(`The official CMake checksum file does not list ${archive.name}`)
    }
    await download(archive.url, archivePath, `${releaseBase}/${archive.name}`)
    const actual = await sha256(archivePath)
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`CMake archive checksum mismatch: expected ${expected}, received ${actual}`)
    }
    run("tar", ["-xf", archivePath, "-C", extractDir])
    const roots = readdirSync(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    if (roots.length !== 1) throw new Error(`The CMake archive contains ${roots.length} top-level directories`)
    mkdirSync(dirname(installDir), { recursive: true })
    renameSync(join(extractDir, roots[0].name), installDir)
    if (!existsSync(executable)) throw new Error(`The CMake archive does not contain ${executable}`)
    writeCmakeMetadata(version, executable)
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true })
  }

  const installed = versionedTool(executable, ["--version"], "3.16")
  if (!installed.ok) throw new Error(`CMake ${version} was installed but cannot be executed`)
  return installed
}

function selectNinja(values) {
  if (ninjaOverride.value) return availableTool(ninjaOverride.value)
  const candidates = ["ninja", configuredNinja(values, sdkDir)].filter(Boolean)
  for (const candidate of candidates) {
    const tool = availableTool(candidate)
    if (tool.ok) return tool
  }
  return availableTool("ninja")
}

function emsdkBuildTool(name) {
  const manifestPath = join(sdkDir, "emsdk_manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x86_64"
  const matches = manifest.tools.filter((tool) => {
    if (tool.id !== name || (tool.arch && tool.arch !== arch) || tool.cmake_build_type) return false
    return Boolean(tool[`url_${os}`] || tool.url)
  })
  const tool = matches.at(-1)
  if (!tool) throw new Error(`emsdk does not provide a prebuilt ${name} for ${process.platform}/${process.arch}`)
  return `${tool.id}-${tool.version}-${tool.bitness}bit`
}

function findPython() {
  const candidates = pythonOverride.value
    ? [{ command: pythonOverride.value, prefix: [] }]
    : process.platform === "win32"
      ? [
          { command: "py", prefix: ["-3"] },
          { command: "python", prefix: [] },
          { command: "python3", prefix: [] },
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] },
        ]

  for (const candidate of candidates) {
    const result = probe(candidate.command, [...candidate.prefix, "--version"])
    const version = numericVersion(result.text)
    if (result.ok && version && versionAtLeast(version, "3.8")) {
      console.log(`Found Python ${version}`)
      return candidate
    }
  }
  throw new Error("Python 3.8+ was not found on PATH. Install it before downloading emsdk.")
}

function run(command, args, cwd = projectDir) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  })
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`Cannot run ${command}. Check the setup prerequisites and retry.`)
    }
    throw result.error
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

requireVersionedTool("Node.js", "node", ["--version"], "22.22.2")
requireVersionedTool("Git", git, ["--version"], "2.25")
const activeConfig = join(sdkDir, ".emscripten")
let values = readEmscriptenConfig(activeConfig)
let cmakeTool = selectCmake()
let ninjaTool = selectNinja(values)
if (cmakeTool.ok) console.log(`Found CMake ${cmakeTool.version}`)
if (ninjaTool.ok) console.log(`Found Ninja ${numericVersion(ninjaTool.text) || firstLine(ninjaTool.text)}`)
if (cmakeOverride.value && !cmakeTool.ok) {
  throw new Error(`${cmakeOverride.name} does not point to CMake 3.16+: ${cmakeOverride.value}`)
}
if (ninjaOverride.value && !ninjaTool.ok) {
  throw new Error(`${ninjaOverride.name} does not point to a working Ninja executable: ${ninjaOverride.value}`)
}

const localCheckoutExists = existsSync(join(sdkDir, ".git"))
const localCompiler = join(sdkDir, "upstream", "emscripten", process.platform === "win32" ? "emcc.exe" : "emcc")
let localSdkMatches = false
if (existsSync(activeConfig)) {
  const installedCompiler = probe(localCompiler, ["--version"], {
    ...process.env,
    EMSDK: sdkDir,
    EM_CONFIG: activeConfig,
  })
  if (exactVersion(installedCompiler, sdkVersion)) {
    console.log(`Found ${firstLine(installedCompiler.text)}`)
    localSdkMatches = true
  } else if (!localCheckoutExists) {
    throw new Error(`${sdkDir} is activated but does not provide Emscripten ${sdkVersion}.`)
  } else if (values.has("EMSCRIPTEN_ROOT")) {
    console.log(`The SDK in ${sdkDir} does not match ${sdkVersion}; activating the pinned version.`)
  }
}

// build.mjs prefers an activated project-local SDK, so avoid probing PATH when
// that SDK already matches. Besides being faster, setup now validates the same
// toolchain that the build will actually select.
let pathSdkMatches = false
if (!localSdkMatches && !existsSync(activeConfig) && !configuredSdkDir) {
  const compiler = probe(emcc, ["--version"])
  const cmakeWrapper = probe(emcmake, [process.execPath, "--version"])
  pathSdkMatches = exactVersion(compiler, sdkVersion) && cmakeWrapper.ok
  if (!pathSdkMatches && (compiler.found || cmakeWrapper.found)) {
    const foundVersion = numericVersion(compiler.text)
    const reason = foundVersion && foundVersion !== sdkVersion ? `version ${foundVersion}` : "an incomplete toolchain"
    console.log(`Ignoring Emscripten on PATH (${reason}); this project requires ${sdkVersion}.`)
  }
}

if (!cmakeTool.ok) {
  requireTool("tar", "tar")
  cmakeTool = await installLatestCmake()
}

if (cmakeTool.ok && ninjaTool.ok && (pathSdkMatches || localSdkMatches)) {
  const source = localSdkMatches
    ? `${configuredBy ? `selected by ${configuredBy}` : "installed locally"} at ${sdkDir}`
    : "already available on PATH"
  console.log(`Using the matching Emscripten SDK ${source}; no download is needed.`)
  process.exit(0)
}

const python = findPython()

if (!localCheckoutExists) {
  if (existsSync(sdkDir)) {
    throw new Error(`${sdkDir} exists but is not an emsdk Git clone; remove it and retry`)
  }
  mkdirSync(dirname(sdkDir), { recursive: true })
  run(git, ["clone", sdkRepository, sdkDir])
} else {
  run(git, ["diff", "--quiet"], sdkDir)
  run(git, ["pull", "--ff-only"], sdkDir)
}

const emsdk = join(sdkDir, "emsdk.py")
const toolsToActivate = []
const toolsToInstall = []
if (!ninjaTool.ok) {
  const tool = emsdkBuildTool("ninja")
  toolsToInstall.push(tool)
  toolsToActivate.push(tool)
  console.log("Ninja was not found; installing a local copy with emsdk.")
}
if (!pathSdkMatches && !localSdkMatches) {
  toolsToInstall.push(sdkVersion)
  toolsToActivate.push(sdkVersion)
}
if (toolsToInstall.length > 0) {
  run(python.command, [...python.prefix, emsdk, "install", ...toolsToInstall], sdkDir)
}
if (toolsToActivate.length > 0) {
  run(python.command, [...python.prefix, emsdk, "activate", ...toolsToActivate], sdkDir)
}

if (!existsSync(join(sdkDir, ".emscripten"))) {
  throw new Error("emsdk activation completed without creating .emscripten")
}

values = readEmscriptenConfig(activeConfig)
cmakeTool = selectCmake()
ninjaTool = selectNinja(values)
if (!cmakeTool.ok) throw new Error("CMake installation completed, but CMake 3.16+ is still unavailable")
if (!ninjaTool.ok) throw new Error("Ninja installation completed, but Ninja is still unavailable")

console.log(`Found CMake ${cmakeTool.version}`)
console.log(`Found Ninja ${numericVersion(ninjaTool.text) || firstLine(ninjaTool.text)}`)
if (pathSdkMatches) {
  console.log(`Emscripten ${sdkVersion} is ready on PATH`)
} else {
  console.log(`Emscripten ${sdkVersion} is ready in ${sdkDir}`)
}
console.log("Run pnpm build:optical-codec or pnpm build:nanorq; both build scripts load this SDK automatically.")
