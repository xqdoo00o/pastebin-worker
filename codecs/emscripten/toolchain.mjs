import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const emscriptenRoot = dirname(fileURLToPath(import.meta.url))
export const codecsRoot = resolve(emscriptenRoot, "..")
export const projectRoot = resolve(codecsRoot, "..")
export const toolsDir = join(codecsRoot, ".tools")
export const defaultEmsdkDir = join(toolsDir, "emsdk")
export const emscriptenVersion = "6.0.6"

export function toolOverride(name) {
  const variableName = `WASM_${name}`
  if (process.env[variableName]) return { name: variableName, value: process.env[variableName] }
  return { name: undefined, value: undefined }
}

export function emsdkLocation() {
  const configured = toolOverride("EMSDK_DIR")
  return {
    configuredBy: configured.name,
    configuredSdkDir: configured.value,
    sdkDir: configured.value ? resolve(projectRoot, configured.value) : defaultEmsdkDir,
  }
}

/** Parse the path values written by `emsdk activate` without executing the
 * Python-flavoured .emscripten file. */
export function readEmscriptenConfig(configPath) {
  if (!existsSync(configPath)) return new Map()
  const values = new Map()
  const config = readFileSync(configPath, "utf8")
  for (const match of config.matchAll(/^([A-Z0-9_]+)\s*=\s*(['"])(.*?)\2/gm)) {
    values.set(match[1], match[3])
  }
  return values
}

export function expandEmscriptenPath(value, sdkDir) {
  if (!value?.startsWith("$CFGDIR")) return value
  return resolve(sdkDir, value.slice("$CFGDIR".length).replace(/^[/\\]/, ""))
}

/** Resolve the activated SDK once and create the clean environment shared by
 * every codec build. Optional callers may fall back to system tools when no
 * local activation exists; an explicit WASM_EMSDK_DIR is always authoritative. */
export function emscriptenBuildContext({ required = true } = {}) {
  const { configuredBy, sdkDir } = emsdkLocation()
  const configPath = join(sdkDir, ".emscripten")
  if (!existsSync(configPath)) {
    if (configuredBy || required) {
      throw new Error(
        `${configPath} does not exist; run pnpm setup:emscripten${configuredBy ? ` or remove ${configuredBy}` : ""}`,
      )
    }
    return { configuredBy, sdkDir, configPath, values: new Map(), emscriptenRoot: undefined, environment: process.env }
  }

  const values = readEmscriptenConfig(configPath)
  const emscriptenRoot = expandEmscriptenPath(values.get("EMSCRIPTEN_ROOT"), sdkDir)
  if (!emscriptenRoot) {
    if (configuredBy || required) throw new Error(`${configPath} does not define EMSCRIPTEN_ROOT`)
    return { configuredBy, sdkDir, configPath, values, emscriptenRoot: undefined, environment: process.env }
  }

  const environment = { ...process.env, EMSDK: sdkDir, EM_CONFIG: configPath }
  delete environment.PYTHONHOME
  delete environment.PYTHONPATH
  return { configuredBy, sdkDir, configPath, values, emscriptenRoot, environment }
}

export function emscriptenExecutable(context, name) {
  if (!context.emscriptenRoot) return undefined
  const executable = process.platform === "win32" ? `${name}.exe` : name
  return join(context.emscriptenRoot, executable)
}

/** emsdk versions have represented Ninja as either NINJA_ROOT or NINJA, with
 * the latter being either a directory or the executable itself. */
export function configuredNinja(values, sdkDir) {
  const executable = process.platform === "win32" ? "ninja.exe" : "ninja"
  const root = expandEmscriptenPath(values.get("NINJA_ROOT"), sdkDir)
  if (root) return join(root, executable)

  const configured = expandEmscriptenPath(values.get("NINJA"), sdkDir)
  if (!configured) return undefined
  return configured.endsWith("ninja") || configured.endsWith("ninja.exe") ? configured : join(configured, executable)
}

/** Resolve the project-local CMake selected by setup and reject metadata that
 * could escape .tools. */
export function localCmakeCommand(toolsDir, { requireExists = false } = {}) {
  const metadataPath = join(toolsDir, "cmake.json")
  if (!existsSync(metadataPath)) return undefined
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
  if (typeof metadata.executable !== "string") {
    throw new Error(`${metadataPath} does not define a CMake executable`)
  }

  const command = resolve(toolsDir, metadata.executable)
  const relativeCommand = relative(toolsDir, command)
  if (isAbsolute(relativeCommand) || relativeCommand.startsWith("..")) {
    throw new Error(`${metadataPath} points outside ${toolsDir}`)
  }
  if (requireExists && !existsSync(command)) throw new Error(`${command} does not exist; run pnpm setup`)
  return command
}
