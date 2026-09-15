import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

import {
  collapseEmscriptenVariantGlue,
  emscriptenCodecBuildContext,
  ensurePinnedGitCheckout,
  preparePatchedSource,
} from "../build-utils.mjs"
import { toolOverride } from "../emscripten/toolchain.mjs"
import { codecBuildState } from "../build-state.mjs"

const { buildHash, codecRoot, outputRoot, stampPath, writeBuildHash } = codecBuildState("nanorq")

const inputHash = buildHash()
const buildDir = join(codecRoot, "build")
const nanorqDir = join(codecRoot, "third_party", "nanorq")
const nanorqPatchDir = join(codecRoot, "patches", "nanorq")
const nanorqRepository = "https://github.com/sleepybishop/nanorq.git"
const nanorqRevision = "6295a9525893b9a757dd57431db76fc6ecceafac"
const git = process.env.NANORQ_GIT || toolOverride("GIT").value || "git"
const { emcc, run, output } = emscriptenCodecBuildContext({ cwd: codecRoot })

function preparePatchedNanoRQSource(revision) {
  const patchedDir = join(buildDir, "nanorq-patched")
  return preparePatchedSource({
    sourceDir: nanorqDir,
    patchedDir,
    expectedPatchedDir: join(buildDir, "nanorq-patched"),
    patchDir: nanorqPatchDir,
    revision,
    stampName: ".nanorq-patches.json",
    requiredPaths: [join("deps", "obl", "oblas_lite.c"), join("include", "nanorq.h")],
    copyEntries: [
      { source: "deps", recursive: true },
      { source: "include", recursive: true },
      { source: "lib", recursive: true },
      { source: "LICENSE" },
    ],
    git,
    run,
    label: "NanoRQ",
    requirePatches: true,
  })
}

ensurePinnedGitCheckout({
  directory: nanorqDir,
  repository: nanorqRepository,
  revision: nanorqRevision,
  sparsePaths: ["deps", "include", "lib"],
  git,
  run,
  output,
  label: "NanoRQ",
})
const patchedNanoRQRoot = preparePatchedNanoRQSource(nanorqRevision)
mkdirSync(outputRoot, { recursive: true })
const sources = [
  join(codecRoot, "src", "nanorq_codec.c"),
  join(patchedNanoRQRoot, "lib", "chooser.c"),
  join(patchedNanoRQRoot, "lib", "nanorq_core.c"),
  join(patchedNanoRQRoot, "lib", "ops.c"),
  join(patchedNanoRQRoot, "lib", "params.c"),
  join(patchedNanoRQRoot, "lib", "partition.c"),
  join(patchedNanoRQRoot, "lib", "sopi.c"),
  join(patchedNanoRQRoot, "lib", "precode.c"),
  join(patchedNanoRQRoot, "lib", "rand.c"),
  join(patchedNanoRQRoot, "lib", "tuple.c"),
  join(patchedNanoRQRoot, "lib", "uvec.c"),
  join(patchedNanoRQRoot, "deps", "obl", "oblas_common.c"),
  join(patchedNanoRQRoot, "deps", "obl", "oblas_lite.c"),
  join(codecRoot, "src", "qrcodegen.c"),
]
function compileNanoRQ(outputName, simd) {
  run(emcc, [
    ...sources,
    `-I${patchedNanoRQRoot}`,
    `-I${join(patchedNanoRQRoot, "include")}`,
    `-I${join(patchedNanoRQRoot, "deps")}`,
    `-I${join(patchedNanoRQRoot, "deps", "obl")}`,
    "-O3",
    "-flto",
    ...(simd ? ["-msimd128", "-funroll-loops", "-ftree-vectorize"] : []),
    "-DNDEBUG",
    "-D_DEFAULT_SOURCE",
    "-D_FILE_OFFSET_BITS=64",
    "-sWASM=1",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sEXPORT_NAME=createNanoRQCodec",
    "-sINCOMING_MODULE_JS_API=wasmBinary,instantiateWasm",
    "-sENVIRONMENT=web,worker",
    "-sFILESYSTEM=0",
    "-sASSERTIONS=0",
    "-sMALLOC=emmalloc",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMAXIMUM_MEMORY=1073741824",
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8",
    "--no-entry",
    "-o",
    join(outputRoot, outputName),
  ])
}

compileNanoRQ("nanorq_codec_simd.js", true)
compileNanoRQ("nanorq_codec_scalar.js", false)

collapseEmscriptenVariantGlue({ outputRoot, baseName: "nanorq_codec" })

copyFileSync(join(codecRoot, "src", "nanorq_codec.d.ts"), join(outputRoot, "nanorq_codec.d.ts"))
copyFileSync(join(patchedNanoRQRoot, "LICENSE"), join(outputRoot, "LICENSE"))
copyFileSync(join(codecRoot, "src", "qrcodegen.LICENSE"), join(outputRoot, "LICENSE.QR-Code-generator"))
writeBuildHash(inputHash)
console.log(`Recorded NanoRQ build state in ${stampPath}`)
