import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { collapseEmscriptenVariantGlue, emscriptenCodecBuildContext, ensurePinnedGitCheckout } from "../build-utils.mjs"
import { codecBuildState } from "../build-state.mjs"
import { toolOverride } from "../emscripten/toolchain.mjs"

const { buildHash, codecRoot, outputRoot, stampPath, writeBuildHash } = codecBuildState("zstd")
const inputHash = buildHash()
const zstdRoot = join(codecRoot, "third_party", "zstd")
const zstdRepository = "https://github.com/facebook/zstd.git"
const zstdRevision = "f8745da6ff1ad1e7bab384bd1f9d742439278e99"
const git = process.env.ZSTD_GIT || toolOverride("GIT").value || "git"
const { emcc, run, output } = emscriptenCodecBuildContext({ cwd: codecRoot })

ensurePinnedGitCheckout({
  directory: zstdRoot,
  repository: zstdRepository,
  revision: zstdRevision,
  sparsePaths: ["lib", "LICENSE"],
  git,
  run,
  output,
  label: "Meta zstd",
})

function cSources(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".c"))
    .map((entry) => join(directory, entry.name))
}

mkdirSync(outputRoot, { recursive: true })
const wrapperSource = join(codecRoot, "src", "zstd_codec.c")
const commonSources = cSources(join(zstdRoot, "lib", "common"))
const encoderSources = [
  wrapperSource,
  ...commonSources,
  ...cSources(join(zstdRoot, "lib", "compress")).filter((path) => !path.endsWith("zstdmt_compress.c")),
]
const threadedEncoderSources = [wrapperSource, ...commonSources, ...cSources(join(zstdRoot, "lib", "compress"))]
const decoderSources = [wrapperSource, ...commonSources, ...cSources(join(zstdRoot, "lib", "decompress"))]
const commonExports = ["_malloc", "_free", "_pw_zstd_error_name"]
const encoderExports = [
  ...commonExports,
  "_pw_zstd_compress_bound",
  "_pw_zstd_compress",
  "_pw_zstd_compressor_new",
  "_pw_zstd_compressor_free",
  "_pw_zstd_compressor_push",
  "_pw_zstd_compressor_finish",
  "_pw_zstd_compressor_output",
  "_pw_zstd_compressor_output_size",
]
const decoderExports = [
  ...commonExports,
  "_pw_zstd_decompress_capacity",
  "_pw_zstd_decompress",
  "_pw_zstd_decompressor_new",
  "_pw_zstd_decompressor_free",
  "_pw_zstd_decompressor_push",
  "_pw_zstd_decompressor_finish",
  "_pw_zstd_decompressor_output",
  "_pw_zstd_decompressor_output_size",
]
const encoderOnlyFlags = [
  "-DPW_ZSTD_ENCODER=1",
  // The application only exposes levels through 4. Keep fast, double-fast
  // and greedy (level 4 uses greedy for small inputs), and compile out all
  // more expensive compression-only strategies.
  "-DZSTD_EXCLUDE_LAZY_BLOCK_COMPRESSOR",
  "-DZSTD_EXCLUDE_LAZY2_BLOCK_COMPRESSOR",
  "-DZSTD_EXCLUDE_BTLAZY2_BLOCK_COMPRESSOR",
  "-DZSTD_EXCLUDE_BTOPT_BLOCK_COMPRESSOR",
  "-DZSTD_EXCLUDE_BTULTRA_BLOCK_COMPRESSOR",
]

const targets = {
  zstd_encoder: {
    exportName: "createZstdEncoder",
    exports: encoderExports,
    flags: encoderOnlyFlags,
    sources: encoderSources,
  },
  zstd_decoder: {
    exportName: "createZstdDecoder",
    exports: decoderExports,
    flags: ["-DPW_ZSTD_DECODER=1"],
    sources: decoderSources,
  },
}

function compileZstd(targetName, target, { capability, simd, threaded = false }) {
  run(emcc, [
    ...(threaded ? threadedEncoderSources : target.sources),
    `-I${join(zstdRoot, "lib")}`,
    `-I${join(zstdRoot, "lib", "common")}`,
    `-I${join(zstdRoot, "lib", "compress")}`,
    `-I${join(zstdRoot, "lib", "decompress")}`,
    "-O3",
    "-flto",
    ...(simd ? ["-msimd128", "-ftree-vectorize"] : []),
    "-DNDEBUG",
    "-DZSTD_DISABLE_ASM=1",
    "-DZSTD_LEGACY_SUPPORT=0",
    ...(threaded ? ["-DZSTD_MULTITHREAD=1", "-DPW_ZSTD_WORKERS=3", "-pthread"] : []),
    ...target.flags,
    "-sWASM=1",
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    `-sEXPORT_NAME=${target.exportName}`,
    "-sINCOMING_MODULE_JS_API=instantiateWasm",
    "-sENVIRONMENT=web,worker",
    "-sFILESYSTEM=0",
    "-sASSERTIONS=0",
    "-sMALLOC=emmalloc",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMAXIMUM_MEMORY=2147483648",
    ...(threaded
      ? ["-sINITIAL_MEMORY=67108864", "-sPTHREAD_POOL_SIZE=3", "-sPTHREAD_POOL_SIZE_STRICT=0", "-pthread"]
      : []),
    `-sEXPORTED_FUNCTIONS=${JSON.stringify(target.exports)}`,
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString",
    "--no-entry",
    "-o",
    join(outputRoot, `${targetName}_${capability}.js`),
  ])
}

for (const [targetName, target] of Object.entries(targets)) {
  compileZstd(targetName, target, { capability: "simd", simd: true })
  compileZstd(targetName, target, { capability: "scalar", simd: false })
}
compileZstd(
  "zstd_encoder",
  { ...targets.zstd_encoder, exportName: "createZstdEncoderThreaded" },
  {
    capability: "threaded",
    simd: true,
    threaded: true,
  },
)

// Every supported caller injects a compiled module. Keep one stable JS wrapper
// per role and discard the duplicate scalar glue.
for (const targetName of Object.keys(targets)) {
  collapseEmscriptenVariantGlue({ outputRoot, baseName: targetName })
}

copyFileSync(join(codecRoot, "src", "zstd_encoder.d.ts"), join(outputRoot, "zstd_encoder.d.ts"))
copyFileSync(join(codecRoot, "src", "zstd_encoder.d.ts"), join(outputRoot, "zstd_encoder_threaded.d.ts"))
copyFileSync(join(codecRoot, "src", "zstd_decoder.d.ts"), join(outputRoot, "zstd_decoder.d.ts"))
copyFileSync(join(zstdRoot, "LICENSE"), join(outputRoot, "LICENSE"))
for (const staleName of ["zstd_codec.js", "zstd_codec.d.ts", "zstd_codec_simd.wasm", "zstd_codec_scalar.wasm"]) {
  rmSync(join(outputRoot, staleName), { force: true })
}
writeBuildHash(inputHash)
console.log(`Recorded zstd build state in ${stampPath}`)
