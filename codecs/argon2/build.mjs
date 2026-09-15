import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { emscriptenCodecBuildContext, ensurePinnedGitCheckout } from "../build-utils.mjs"
import { toolOverride } from "../emscripten/toolchain.mjs"
import { codecBuildState } from "../build-state.mjs"

const { buildHash, codecRoot: root, outputRoot: output, writeBuildHash } = codecBuildState("argon2")
const inputHash = buildHash()
const source = join(root, "third_party", "monocypher")
const revision = "1830c06d5910fba451cec329c8f30f348fc607db"
const repository = "https://github.com/LoupVaillant/Monocypher.git"
const git = process.env.ARGON2_MONOCYPHER_GIT || toolOverride("GIT").value || "git"
const { emcc, run, output: commandOutput } = emscriptenCodecBuildContext({ cwd: root })

ensurePinnedGitCheckout({
  directory: source,
  repository,
  revision,
  git,
  run,
  output: commandOutput,
  label: "Monocypher",
  sparsePaths: ["src", "LICENCE.md"],
})
mkdirSync(output, { recursive: true })

run(emcc, [
  join(root, "src", "argon2_monocypher.c"),
  join(source, "src", "monocypher.c"),
  `-I${join(source, "src")}`,
  "-O3",
  "-flto",
  "-msimd128",
  "-sWASM=1",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sEXPORT_NAME=createArgon2Module",
  "-sINCOMING_MODULE_JS_API=['instantiateWasm']",
  "-sEXPORTED_FUNCTIONS=['_argon2_monocypher_verify','_argon2_monocypher_hash','_malloc','_free']",
  "-sEXPORTED_RUNTIME_METHODS=HEAPU8",
  "-sENVIRONMENT=web,worker",
  "-sFILESYSTEM=0",
  "-sASSERTIONS=0",
  "-sMALLOC=emmalloc",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sMAXIMUM_MEMORY=1073741824",
  "--no-entry",
  "-o",
  join(output, "argon2_bg.js"),
])
cpSync(join(root, "src", "argon2.js"), join(output, "argon2.js"))
cpSync(join(root, "src", "argon2.d.ts"), join(output, "argon2.d.ts"))
writeBuildHash(inputHash)
console.log(`Recorded Argon2 build state in ${join(output, ".build-hash")}`)
