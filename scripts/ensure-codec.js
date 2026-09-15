import { spawnSync } from "node:child_process"
import { join } from "node:path"

import { codecBuildState } from "../codecs/build-state.mjs"

const codecNames = process.argv.slice(2)
if (codecNames.length === 0) {
  throw new Error("Usage: node scripts/ensure-codec.js <nanorq|optical|argon2|zstd|xxhash> [...]")
}

for (const codecName of codecNames) {
  const state = codecBuildState(codecName)
  const expectedHash = state.buildHash()
  if (state.outputsExist() && state.storedBuildHash() === expectedHash) {
    console.log(`${state.label} is up to date`)
    continue
  }

  const buildArgs = [join(state.codecRoot, "build.mjs")]
  if (state.passOutputArgument) buildArgs.push("--output", state.outputRoot)
  const result = spawnSync(process.execPath, buildArgs, {
    cwd: state.projectRoot,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)

  if (!state.outputsExist() || state.storedBuildHash() !== state.buildHash()) {
    throw new Error(
      `${state.label} inputs changed during the build or the generated package is incomplete; run it again.`,
    )
  }
}
