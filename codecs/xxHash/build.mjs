import { join } from "node:path"

import {
  emscriptenModuleFlags,
  copyFileIfChanged,
  createCodecBuildOutput,
  collapseEmscriptenVariantGlue,
  emscriptenCodecBuildContext,
  ensurePinnedGitCheckout,
} from "../build-utils.mjs"
import { codecBuildState } from "../build-state.mjs"
import { toolOverride } from "../emscripten/toolchain.mjs"

const { buildHash, codecRoot, outputRoot, stampPath, writeBuildHash } = codecBuildState("xxhash")
const inputHash = buildHash()
const xxhashRoot = join(codecRoot, "third_party", "xxHash")
const xxhashRepository = "https://github.com/Cyan4973/xxHash.git"
const xxhashRevision = "c87183a77d67f7d37e3d2d1b7eaac5e7c695e4f0"
const git = toolOverride("GIT").value || "git"
const { emcc, run, output } = emscriptenCodecBuildContext({ cwd: codecRoot })

ensurePinnedGitCheckout({
  directory: xxhashRoot,
  repository: xxhashRepository,
  revision: xxhashRevision,
  sparsePaths: ["."],
  git,
  run,
  output,
  label: "official xxHash",
})

const buildOutput = createCodecBuildOutput(codecRoot, outputRoot)
const exports = [
  "_malloc",
  "_free",
  "_pw_xxh3_64bits",
  "_pw_xxh3_state_new",
  "_pw_xxh3_state_free",
  "_pw_xxh3_state_reset",
  "_pw_xxh3_state_update",
  "_pw_xxh3_state_digest",
]

function compileXXHash(simd) {
  const capability = simd ? "simd" : "scalar"
  run(emcc, [
    join(codecRoot, "src", "xxhash_codec.c"),
    join(xxhashRoot, "xxhash.c"),
    `-I${xxhashRoot}`,
    "-O3",
    "-flto",
    ...(simd ? ["-msimd128"] : ["-DXXH_VECTOR=XXH_SCALAR"]),
    "-DNDEBUG",
    ...emscriptenModuleFlags({
      exportName: "createXXHash",
      maximumMemory: 2147483648,
    }),
    "-sWASM_BIGINT=1",
    `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports)}`,
    "-o",
    join(buildOutput.directory, `xxhash_${capability}.js`),
  ])
}

compileXXHash(true)
compileXXHash(false)

// Both variants have the same imports and exports. Keep one stable JS factory;
// callers inject the selected compiled WebAssembly.Module.
collapseEmscriptenVariantGlue({ outputRoot: buildOutput.directory, baseName: "xxhash" })
buildOutput.publish()

copyFileIfChanged(join(codecRoot, "src", "xxhash.d.ts"), join(outputRoot, "xxhash.d.ts"))
copyFileIfChanged(join(xxhashRoot, "LICENSE"), join(outputRoot, "LICENSE"))
writeBuildHash(inputHash)
console.log(`Recorded xxHash build state in ${stampPath}`)
