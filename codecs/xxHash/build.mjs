import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import { collapseEmscriptenVariantGlue, emscriptenCodecBuildContext, ensurePinnedGitCheckout } from "../build-utils.mjs"
import { codecBuildState } from "../build-state.mjs"
import { toolOverride } from "../emscripten/toolchain.mjs"

const { buildHash, codecRoot, outputRoot, stampPath, writeBuildHash } = codecBuildState("xxhash")
const inputHash = buildHash()
const xxhashRoot = join(codecRoot, "third_party", "xxHash")
const xxhashRepository = "https://github.com/Cyan4973/xxHash.git"
const xxhashRevision = "e626a72bc2321cd320e953a0ccf1584cad60f363"
const git = process.env.XXHASH_GIT || toolOverride("GIT").value || "git"
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

mkdirSync(outputRoot, { recursive: true })
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
    "-sWASM=1",
    "-sWASM_BIGINT=1",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createXXHash",
    "-sINCOMING_MODULE_JS_API=instantiateWasm",
    "-sENVIRONMENT=web,worker",
    "-sFILESYSTEM=0",
    "-sASSERTIONS=0",
    "-sMALLOC=emmalloc",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMAXIMUM_MEMORY=2147483648",
    `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports)}`,
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8",
    "--no-entry",
    "-o",
    join(outputRoot, `xxhash_${capability}.js`),
  ])
}

compileXXHash(true)
compileXXHash(false)

// Both variants have the same imports and exports. Keep one stable JS factory;
// callers inject the selected compiled WebAssembly.Module.
collapseEmscriptenVariantGlue({ outputRoot, baseName: "xxhash" })

copyFileSync(join(codecRoot, "src", "xxhash.d.ts"), join(outputRoot, "xxhash.d.ts"))
copyFileSync(join(xxhashRoot, "LICENSE"), join(outputRoot, "LICENSE"))
writeBuildHash(inputHash)
console.log(`Recorded xxHash build state in ${stampPath}`)
