import { Buffer } from "node:buffer"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"

import {
  collapseEmscriptenVariantGlueSource,
  commandRunner,
  ensurePinnedGitCheckout,
  preparePatchedSource,
} from "../build-utils.mjs"
import {
  configuredNinja,
  emscriptenBuildContext,
  emscriptenVersion,
  expandEmscriptenPath,
  localCmakeCommand,
  toolOverride,
  toolsDir,
} from "../emscripten/toolchain.mjs"
import { codecBuildState } from "../build-state.mjs"

const {
  buildHash,
  codecRoot: projectDir,
  outputRoot: frontendOutputRoot,
  stampPath,
  writeBuildHash,
} = codecBuildState("optical")
const options = buildOptions(process.argv.slice(2))
const buildDir = join(projectDir, options.development ? "build-dev" : "build")
const scalarBuildDir = join(projectDir, options.development ? "build-dev-scalar" : "build-scalar")
const thirdPartyDir = join(projectDir, "third_party")
const zxingDir = join(thirdPartyDir, "zxing-cpp")
const zxingPatchDir = join(projectDir, "patches", "zxing-cpp")
const codecVersion = "1.0.0"
const zxingRepository = "https://github.com/zxing-cpp/zxing-cpp.git"
const zxingRevision = "db11a782d9f8a99d9cc504360bc72e770c5e250d"
const git = toolOverride("GIT").value || "git"

const local = emscriptenBuildContext({ required: false })
const expand = (value) => expandEmscriptenPath(value, local.sdkDir)
const cmake = toolOverride("CMAKE").value || localCmakeCommand(toolsDir, { requireExists: true }) || "cmake"
const ninja = toolOverride("NINJA").value || configuredNinja(local.values, local.sdkDir)

function localEmsdk() {
  const emscriptenRoot = local.emscriptenRoot
  if (!emscriptenRoot) return null

  const environment = { ...local.environment }
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH"
  const inheritedPath = environment[pathKey]
  for (const key of Object.keys(environment)) {
    if (key !== pathKey && key.toLowerCase() === "path") delete environment[key]
  }
  environment[pathKey] = [
    local.sdkDir,
    emscriptenRoot,
    cmake !== "cmake" ? dirname(cmake) : undefined,
    ninja ? dirname(ninja) : undefined,
    inheritedPath,
  ]
    .filter(Boolean)
    .join(delimiter)
  const node = expand(local.values.get("NODE_JS"))
  const python = expand(local.values.get("PYTHON"))
  if (node) environment.EMSDK_NODE = node
  if (python) environment.EMSDK_PYTHON = python
  delete environment.PYTHONHOME
  delete environment.PYTHONPATH

  const launcher = join(emscriptenRoot, process.platform === "win32" ? "emcmake.exe" : "emcmake")
  if (existsSync(launcher)) return { command: launcher, prefix: [], environment }

  const pythonScript = join(emscriptenRoot, "emcmake.py")
  if (python && existsSync(pythonScript)) {
    return { command: python, prefix: [pythonScript], environment }
  }
  throw new Error(`No emcmake launcher was found under ${emscriptenRoot}`)
}

const sdk = localEmsdk()
const emcmakeOverride = toolOverride("EMCMAKE").value
const emcmake = emcmakeOverride
  ? { command: emcmakeOverride, prefix: [], environment: process.env }
  : (sdk ?? { command: "emcmake", prefix: [], environment: process.env })
const buildEnvironment = { ...emcmake.environment }
if (process.env.OPTICAL_COMPILER_WRAPPER) {
  buildEnvironment.EM_COMPILER_WRAPPER = process.env.OPTICAL_COMPILER_WRAPPER
}
const { run, output } = commandRunner({
  cwd: projectDir,
  environment: buildEnvironment,
  missingCommand: (command) => `Cannot run ${command}. Run pnpm setup:emscripten and verify the configured tool paths.`,
})

function buildOptions(args) {
  let development = false
  let requestedOutput
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dev") {
      development = true
    } else if (args[index] === "--output") {
      const value = args[++index]
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a directory")
      }
      requestedOutput = value
    } else {
      throw new Error("Usage: node build.mjs [--dev] [--output <directory>]")
    }
  }
  return {
    development,
    outputDir: requestedOutput
      ? resolve(projectDir, requestedOutput)
      : join(projectDir, development ? "dist-dev" : "dist"),
  }
}

function preparePatchedZxingSource(zxingRevision) {
  const patchedDir = join(buildDir, "zxing-cpp-patched")
  return preparePatchedSource({
    sourceDir: zxingDir,
    patchedDir,
    expectedPatchedDir: join(buildDir, "zxing-cpp-patched"),
    patchDir: zxingPatchDir,
    revision: zxingRevision,
    stampName: ".optical-patches.json",
    requiredPaths: [join("core", "CMakeLists.txt")],
    copyEntries: [{ source: "core", recursive: true }],
    git,
    run,
    label: "zxing-cpp",
    resultPath: "core",
  })
}

function prepareBuildDirectory(variantBuildDir, simd) {
  const stampPath = join(variantBuildDir, ".optical-toolchain.json")
  const identity = `${JSON.stringify(
    {
      cmake,
      ninja: ninja || null,
      emcmake: emcmake.command,
      emcmakePrefix: emcmake.prefix,
      emConfig: buildEnvironment.EM_CONFIG || null,
      emscriptenRoot: expand(local.values.get("EMSCRIPTEN_ROOT")) || null,
      emscriptenVersion,
      compilerWrapper: buildEnvironment.EM_COMPILER_WRAPPER || null,
      buildType: "Release",
      lto: !options.development,
      simd,
      zxingSource: "patched-build-tree-v1",
    },
    null,
    2,
  )}\n`
  const previous = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : null
  const generatedBuildExists = existsSync(join(variantBuildDir, "CMakeCache.txt")) || previous !== null
  if (generatedBuildExists && previous !== identity) {
    const expectedBuildDirs = [
      resolve(projectDir, options.development ? "build-dev" : "build"),
      resolve(projectDir, options.development ? "build-dev-scalar" : "build-scalar"),
    ]
    if (!expectedBuildDirs.includes(resolve(variantBuildDir))) throw new Error(`Refusing to reset ${variantBuildDir}`)
    console.log("The build toolchain changed; resetting the generated CMake build directory.")
    rmSync(variantBuildDir, { recursive: true, force: true })
  }
  mkdirSync(variantBuildDir, { recursive: true })
  if (previous !== identity) writeFileSync(stampPath, identity)
  return !existsSync(join(variantBuildDir, "build.ninja"))
}

function writeIfChanged(destination, content) {
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content)
  if (existsSync(destination) && readFileSync(destination).equals(next)) return false
  writeFileSync(destination, next)
  return true
}

const outputDir = options.outputDir
const writesFrontendArtifacts = resolve(outputDir) === resolve(frontendOutputRoot)
const sourceHash = buildHash()
const inputHash = writesFrontendArtifacts ? sourceHash : null
const version = codecVersion
const buildFlavor = options.development ? "dev" : "release"
const buildId = `${buildFlavor}-${sourceHash.slice(0, 12)}`

ensurePinnedGitCheckout({
  directory: zxingDir,
  repository: zxingRepository,
  revision: zxingRevision,
  sparsePaths: ["core"],
  git,
  run,
  output,
  label: "zxing-cpp",
})
// Configure-directory cleanup must happen before creating the patched ZXing
// copy because the SIMD build owns that disposable source tree.
const simdNeedsConfigure = prepareBuildDirectory(buildDir, true)
const scalarNeedsConfigure = prepareBuildDirectory(scalarBuildDir, false)
const patchedZxingSource = preparePatchedZxingSource(zxingRevision)
mkdirSync(outputDir, { recursive: true })

function buildVariant(variantBuildDir, simd, needsConfigure) {
  const configureArgs = [
    ...emcmake.prefix,
    cmake,
    "-S",
    projectDir,
    "-B",
    variantBuildDir,
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DOPTICAL_ENABLE_LTO=${options.development ? "OFF" : "ON"}`,
    `-DOPTICAL_ENABLE_SIMD=${simd ? "ON" : "OFF"}`,
    `-DOPTICAL_ZXING_SOURCE_DIR=${patchedZxingSource}`,
  ]
  if (ninja) configureArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninja}`)
  if (needsConfigure) run(emcmake.command, configureArgs)
  run(cmake, ["--build", variantBuildDir])
  return {
    js: readFileSync(join(variantBuildDir, "optical_codec.js"), "utf8"),
    wasm: readFileSync(join(variantBuildDir, "optical_codec.wasm")),
  }
}

const simd = buildVariant(buildDir, true, simdNeedsConfigure)
const scalar = buildVariant(scalarBuildDir, false, scalarNeedsConfigure)
const banner = `/*! optical-codec v${version} — build ${buildId} — local source build */\n`
const generatedSimdJs = simd.js.replaceAll("optical_codec.wasm", "optical_codec_simd.wasm")
const changed = [
  writeIfChanged(
    join(outputDir, "optical_codec.js"),
    banner + collapseEmscriptenVariantGlueSource(generatedSimdJs, "optical_codec"),
  ),
  writeIfChanged(join(outputDir, "optical_codec_simd.wasm"), simd.wasm),
  writeIfChanged(join(outputDir, "optical_codec_scalar.wasm"), scalar.wasm),
  writeIfChanged(join(outputDir, "optical_codec.d.ts"), readFileSync(join(projectDir, "src", "optical_codec.d.ts"))),
].some(Boolean)
const legacyWasmPath = join(outputDir, "optical_codec.wasm")
const removedLegacyWasm = existsSync(legacyWasmPath)
rmSync(legacyWasmPath, { force: true })

if (inputHash !== null) {
  if (buildHash() !== inputHash) {
    throw new Error("Optical codec inputs changed during the build; run the build again.")
  }
  writeBuildHash(inputHash)
  console.log(`Recorded optical codec build state in ${stampPath}`)
}
console.log(changed || removedLegacyWasm ? `Wrote ${outputDir}` : `Artifacts are unchanged in ${outputDir}`)
