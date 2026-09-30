import { mkdirSync } from "node:fs"
import { join } from "node:path"

import {
  emscriptenModuleFlags,
  copyFileIfChanged,
  emscriptenCodecBuildContext,
  ensurePinnedGitCheckout,
} from "../build-utils.mjs"
import { toolOverride } from "../emscripten/toolchain.mjs"
import { codecBuildState } from "../build-state.mjs"

const { buildHash, codecRoot: root, outputRoot: output, writeBuildHash } = codecBuildState("argon2")
const inputHash = buildHash()
const source = join(root, "third_party", "monocypher")
const revision = "1830c06d5910fba451cec329c8f30f348fc607db"
const repository = "https://github.com/LoupVaillant/Monocypher.git"
const git = toolOverride("GIT").value || "git"
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
  ...emscriptenModuleFlags({
    exportName: "createArgon2Module",
    maximumMemory: 1073741824,
    incomingModuleApi: "['instantiateWasm']",
  }),
  "-sEXPORTED_FUNCTIONS=['_argon2_monocypher_verify','_argon2_monocypher_hash','_malloc','_free']",
  "-o",
  join(output, "argon2_bg.js"),
])
copyFileIfChanged(join(root, "src", "argon2.js"), join(output, "argon2.js"))
copyFileIfChanged(join(root, "src", "argon2.d.ts"), join(output, "argon2.d.ts"))
writeBuildHash(inputHash)
console.log(`Recorded Argon2 build state in ${join(output, ".build-hash")}`)
