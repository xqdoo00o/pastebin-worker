# Official xxHash WebAssembly codec

This directory builds the official `Cyan4973/xxHash` C implementation into
SIMD128 and scalar WebAssembly variants. The source checkout is pinned to the
v0.8.3 release and kept under the ignored `third_party/` directory.

Run `pnpm build:xxhash` after configuring the shared Emscripten toolchain with
`pnpm setup:emscripten`. Generated browser artifacts are written to
`frontend/wasm/xxhash/`.

The wrapper exposes the official `XXH3_64bits()` one-shot API plus the
`XXH3_createState()`, `XXH3_64bits_reset()`, `XXH3_64bits_update()`,
`XXH3_64bits_digest()` and `XXH3_freeState()` streaming lifecycle.
