# Official Zstandard WebAssembly codec

This directory builds the official Meta `facebook/zstd` C implementation into
separate encoder and decoder modules. The encoder has scalar, SIMD128 and
hosted-only SIMD128/pthreads variants; the decoder has scalar and SIMD128
variants.
The checkout is pinned by commit and is kept under the ignored `third_party/`
directory.

Run `pnpm build:zstd` after configuring the shared Emscripten toolchain with
`pnpm setup:emscripten`. Generated browser artifacts are written to
`frontend/wasm/zstd/`.

The encoder exposes one-shot compression plus a stateful
`ZSTD_compressStream2()` context. The decoder wraps
`ZSTD_decompressStream()`, so frame parsing, partial-input recovery,
concatenated frames and skippable frames remain owned by the official decoder.
The browser runtime loads only the role used by the current page or worker.
The threaded encoder is selected only for sufficiently large inputs in a
cross-origin-isolated hosted page. Standalone HTML and browsers without shared
WebAssembly memory continue to use the existing single-threaded builds.

Run the browser benchmark with `pnpm benchmark:zstd`. It compares the regular
SIMD encoder with the pthread/SIMD encoder on structured and incompressible
inputs. Use `--size-mib` and `--samples` to change the defaults, or
`--baseline <directory>` to compare against saved generated artifacts. Set
`ZSTD_BENCHMARK_BROWSER` when Chrome or Edge is installed in a nonstandard
location.

The browser API intentionally caps compression at level 4. The build retains
the fast, double-fast and greedy compressors required by levels 1 through 4,
and excludes the lazy and binary-tree/optimal compression strategies used by
higher levels. This only reduces encoding capabilities: the official decoder
remains able to read standard zstd frames produced at every compression level.
