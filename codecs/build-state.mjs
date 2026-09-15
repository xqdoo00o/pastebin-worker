import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const codecsRoot = dirname(fileURLToPath(import.meta.url))
const buildUtilsPath = join(codecsRoot, "build-utils.mjs")
export const projectRoot = resolve(codecsRoot, "..")

const definitions = {
  nanorq: {
    label: "NanoRQ SIMD/scalar WASM",
    outputDirectory: "nanorq-codec",
    requiredOutputs: [
      "LICENSE",
      "LICENSE.QR-Code-generator",
      "nanorq_codec.js",
      "nanorq_codec_simd.wasm",
      "nanorq_codec_scalar.wasm",
      "nanorq_codec.d.ts",
    ],
    inputs: ["build.mjs"],
    salt: "pastebin-worker:nanorq-web-simd-and-scalar:v3\0",
  },
  optical: {
    label: "Optical codec SIMD/scalar WASM",
    passOutputArgument: true,
    outputDirectory: "codec",
    requiredOutputs: ["optical_codec.js", "optical_codec_simd.wasm", "optical_codec_scalar.wasm", "optical_codec.d.ts"],
    inputs: ["CMakeLists.txt", "build.mjs"],
    salt: "pastebin-worker:optical-codec-web-simd-and-scalar:v2\0",
  },
  argon2: {
    label: "Argon2 Monocypher WASM",
    localOutputDirectory: "dist",
    requiredOutputs: ["argon2.js", "argon2.d.ts", "argon2_bg.js", "argon2_bg.wasm"],
    inputs: ["build.mjs"],
    salt: "pastebin-worker:argon2-web-monocypher:v1\0",
  },
  zstd: {
    label: "Meta zstd encoder/decoder threaded/SIMD/scalar WASM",
    frontendOutputPath: ["wasm", "zstd"],
    requiredOutputs: [
      "LICENSE",
      "zstd_encoder.js",
      "zstd_encoder.d.ts",
      "zstd_encoder_simd.wasm",
      "zstd_encoder_scalar.wasm",
      "zstd_encoder_threaded.js",
      "zstd_encoder_threaded.d.ts",
      "zstd_encoder_threaded.wasm",
      "zstd_decoder.js",
      "zstd_decoder.d.ts",
      "zstd_decoder_simd.wasm",
      "zstd_decoder_scalar.wasm",
    ],
    inputs: ["build.mjs"],
    salt: "pastebin-worker:zstd-official-split-level-4-threaded-simd-and-scalar:v4\0",
  },
  xxhash: {
    label: "Official XXH3 SIMD/scalar WASM",
    projectDirectory: "codecs/xxHash",
    frontendOutputPath: ["wasm", "xxhash"],
    requiredOutputs: ["LICENSE", "xxhash.js", "xxhash.d.ts", "xxhash_simd.wasm", "xxhash_scalar.wasm"],
    inputs: ["build.mjs"],
    salt: "pastebin-worker:xxhash-official-xxh3-simd-and-scalar:v1\0",
  },
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  })
}

function normalizedContents(path) {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n")
}

export function codecBuildState(codecName) {
  const definition = definitions[codecName]
  if (!definition) throw new Error(`Unknown codec build state: ${codecName}`)

  const codecRoot = definition.projectDirectory
    ? join(projectRoot, definition.projectDirectory)
    : join(codecsRoot, codecName)
  const outputRoot = definition.localOutputDirectory
    ? join(codecRoot, definition.localOutputDirectory)
    : definition.frontendOutputPath
      ? join(projectRoot, "frontend", ...definition.frontendOutputPath)
      : join(projectRoot, "frontend", "optical", definition.outputDirectory)
  const stampPath = join(outputRoot, ".build-hash")

  function buildHash() {
    const inputs = [
      buildUtilsPath,
      ...definition.inputs.map((path) => join(codecRoot, path)),
      join(codecsRoot, "emscripten", "toolchain.mjs"),
      ...sourceFiles(join(codecRoot, "patches")),
      ...sourceFiles(join(codecRoot, "src")),
    ].sort()
    const hash = createHash("sha256")

    hash.update(definition.salt)
    for (const path of inputs) {
      hash.update(relative(projectRoot, path).replaceAll("\\", "/"))
      hash.update("\0")
      hash.update(normalizedContents(path))
      hash.update("\0")
    }
    return hash.digest("hex")
  }

  function outputsExist() {
    return definition.requiredOutputs.every((name) => existsSync(join(outputRoot, name)))
  }

  function storedBuildHash() {
    return existsSync(stampPath) ? readFileSync(stampPath, "utf8").trim() : ""
  }

  function writeBuildHash(hash) {
    writeFileSync(stampPath, `${hash}\n`)
  }

  return {
    buildHash,
    codecRoot,
    label: definition.label,
    outputRoot,
    passOutputArgument: definition.passOutputArgument === true,
    outputsExist,
    projectRoot,
    stampPath,
    storedBuildHash,
    writeBuildHash,
  }
}
