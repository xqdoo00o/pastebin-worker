import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

import { emscriptenBuildContext, emscriptenExecutable } from "./emscripten/toolchain.mjs"

export function commandRunner({ cwd: defaultCwd, environment: defaultEnvironment = process.env, missingCommand }) {
  function run(command, args, cwd = defaultCwd, environment = defaultEnvironment) {
    const result = spawnSync(command, args, { cwd, env: environment, stdio: "inherit" })
    if (result.error) {
      if (result.error.code === "ENOENT") {
        throw new Error(missingCommand?.(command) ?? `Cannot run ${command}; verify that it is installed and on PATH.`)
      }
      throw result.error
    }
    if (result.status !== 0) process.exit(result.status ?? 1)
  }

  function output(command, args, cwd = defaultCwd, environment = defaultEnvironment) {
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8" })
    return result.status === 0 ? result.stdout.trim() : ""
  }

  return { run, output }
}

export function emscriptenCodecBuildContext({ cwd, missingCommand } = {}) {
  const toolchain = emscriptenBuildContext()
  const emcc = emscriptenExecutable(toolchain, "emcc")

  if (!emcc || !existsSync(emcc))
    throw new Error(`Emscripten is not configured under ${toolchain.sdkDir}; run pnpm setup:emscripten`)

  const { run, output } = commandRunner({
    cwd,
    environment: toolchain.environment,
    missingCommand,
  })
  return { emcc, run, output, sdkDir: toolchain.sdkDir }
}

export function gitState(output, git, cwd, args = []) {
  const lines = output(git, ["status", "--porcelain=v2", "--branch", ...args], cwd).split(/\r?\n/)
  const oid = lines.find((line) => line.startsWith("# branch.oid "))?.slice("# branch.oid ".length)
  const changes = lines.filter((line) => line && !line.startsWith("# "))
  return { revision: oid && oid !== "(initial)" ? oid : "", changes }
}

/** Ensure a disposable sparse checkout is pinned to the exact source revision. */
export function ensurePinnedGitCheckout({ directory, repository, revision, sparsePaths, git, run, output, label }) {
  const gitDir = join(directory, ".git")
  if (!existsSync(gitDir)) {
    if (existsSync(directory)) {
      throw new Error(`${directory} exists but is not a Git clone; remove it and run this command again`)
    }
    mkdirSync(directory, { recursive: true })
    run(git, ["init", "--quiet"], directory)
    run(git, ["remote", "add", "origin", repository], directory)
    run(git, ["sparse-checkout", "init", "--cone"], directory)
    run(git, ["sparse-checkout", "set", ...sparsePaths], directory)
  }

  const origin = output(git, ["remote", "get-url", "origin"], directory)
  if (origin !== repository) {
    throw new Error(`${directory} has an unexpected origin: ${origin || "none"}`)
  }

  let state = gitState(output, git, directory)
  if (state.changes.length > 0) {
    throw new Error(`Refusing local changes in the pristine ${label} checkout:\n${state.changes.join("\n")}`)
  }

  if (state.revision !== revision) {
    run(git, ["fetch", "--filter=blob:none", "--depth=1", "origin", revision], directory)
    run(git, ["checkout", "--detach", revision], directory)
    state = gitState(output, git, directory)
    if (state.revision !== revision) throw new Error(`Failed to check out ${label} ${revision}`)
  }
}

export function readPatchFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((name) => name.endsWith(".patch"))
    .sort()
    .map((name) => ({
      name,
      path: resolve(directory, name),
      contents: readFileSync(resolve(directory, name), "utf8"),
    }))
}

export function patchSetDigest(revision, patches) {
  const hash = createHash("sha256")
  hash.update(revision)
  for (const patch of patches) {
    hash.update("\0")
    hash.update(patch.name)
    hash.update("\0")
    hash.update(patch.contents)
  }
  return hash.digest("hex")
}

export function applyPatchFiles({ patches, cwd, git, run, label }) {
  for (const patch of patches) {
    run(git, ["apply", "--check", patch.path], cwd)
    run(git, ["apply", patch.path], cwd)
    console.log(`Applied ${label} patch ${patch.name}`)
  }
}

export function resetExpectedDirectory(directory, expectedDirectory) {
  if (resolve(directory) !== resolve(expectedDirectory)) {
    throw new Error(`Refusing to replace unexpected directory ${directory}`)
  }
  rmSync(directory, { recursive: true, force: true })
}

/** Materialize and patch a disposable source tree. The identity stamp keeps
 * codec builds incremental while every destructive operation remains pinned
 * to the caller's explicit build directory. */
export function preparePatchedSource({
  sourceDir,
  patchedDir,
  expectedPatchedDir,
  patchDir,
  revision,
  stampName,
  requiredPaths,
  copyEntries,
  git,
  run,
  label,
  resultPath = ".",
  requirePatches = false,
}) {
  const patches = readPatchFiles(patchDir)
  if (requirePatches && patches.length === 0) throw new Error(`No ${label} patches were found under ${patchDir}`)

  const stampPath = join(patchedDir, stampName)
  const identity = `${JSON.stringify(
    { layout: "staged-git-v1", revision, patches: patchSetDigest(revision, patches) },
    null,
    2,
  )}\n`
  if (
    requiredPaths.every((path) => existsSync(join(patchedDir, path))) &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8") === identity
  ) {
    return resolve(patchedDir, resultPath)
  }

  resetExpectedDirectory(patchedDir, expectedPatchedDir)
  mkdirSync(patchedDir, { recursive: true })
  for (const entry of copyEntries) {
    const source = join(sourceDir, entry.source)
    const destination = join(patchedDir, entry.destination ?? entry.source)
    mkdirSync(dirname(destination), { recursive: true })
    if (entry.recursive) cpSync(source, destination, { recursive: true })
    else copyFileSync(source, destination)
  }

  // Keep git apply rooted inside the disposable copy instead of allowing it
  // to discover the enclosing project checkout.
  run(git, ["init", "--quiet"], patchedDir)
  applyPatchFiles({ patches, cwd: patchedDir, git, run, label })
  writeFileSync(stampPath, identity)
  return resolve(patchedDir, resultPath)
}

/** Rewrite generated SIMD glue so its default fallback targets the SIMD asset.
 * Callers can then retain this one factory for either explicitly supplied
 * scalar/SIMD module without writing transient glue files to their output. */
export function collapseEmscriptenVariantGlueSource(simdJs, baseName) {
  const wasmName = `${baseName}_simd.wasm`
  const fallback = `return new URL("${wasmName}",import.meta.url).href`
  const locateFallback = `return locateFile("${wasmName}")`
  if (!simdJs.includes(fallback) || !simdJs.includes(locateFallback)) {
    throw new Error(`${baseName} Emscripten fallback URL changed; update the build post-processing.`)
  }
  return simdJs.replace(fallback, `return "${wasmName}"`)
}

/** Keep one stable Emscripten JS factory while retaining scalar/SIMD WASM binaries. */
export function collapseEmscriptenVariantGlue({ outputRoot, baseName }) {
  const generatedSimdJsPath = join(outputRoot, `${baseName}_simd.js`)
  const sharedJsPath = join(outputRoot, `${baseName}.js`)
  const scalarJsPath = join(outputRoot, `${baseName}_scalar.js`)
  const simdJs = readFileSync(generatedSimdJsPath, "utf8")
  rmSync(sharedJsPath, { force: true })
  writeFileSync(generatedSimdJsPath, collapseEmscriptenVariantGlueSource(simdJs, baseName))
  renameSync(generatedSimdJsPath, sharedJsPath)
  rmSync(scalarJsPath, { force: true })
}
