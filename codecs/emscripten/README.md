# Shared Emscripten toolchain

This directory owns the Emscripten toolchain shared by the Optical and NanoRQ
WebAssembly codecs. Generated tools live under the ignored `codecs/.tools/`
directory rather than under either codec.

From the repository root, run:

```sh
pnpm setup:emscripten
```

The setup checks Node.js 22.22.2+, Git 2.25+, CMake 3.16+, Ninja, and the pinned
Emscripten version from `toolchain.mjs`. It reuses compatible CMake and Ninja
tools and installs or reuses the activated SDK in `codecs/.tools/emsdk/` (or
`WASM_EMSDK_DIR`). An SDK found only on PATH does not satisfy setup. Python 3.8+
is only required when emsdk or Ninja must be installed; downloaded CMake archives require `tar` and
are verified against Kitware's published SHA-256 checksum.

All codec builds load `codecs/.tools/emsdk/.emscripten` automatically, so no
shell activation is needed. Set `WASM_EMSDK_DIR` to use another activated emsdk
checkout. `WASM_GIT`, `WASM_PYTHON`, `WASM_CMAKE`, `WASM_NINJA`, and `WASM_CURL`
override individual setup tools. The Optical build also accepts `WASM_EMCMAKE`.
