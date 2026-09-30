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
When a complete input has no declared decompressed size, the runtime reuses the
input allocation from its size probe for streaming decompression. Streaming
output reuses retained capacity when it can hold the next frame's declared
size, allowing the library's single-pass shortcut without speculative growth.
Other writes remain block-sized, with an extra byte at the output ceiling to
detect over-limit data.
For disk-backed assembly, `pushChunks()` uses the incremental
`pw_zstd_decompressor_step` API to emit at most 128 KiB before yielding to the
writer. This bounds pending output even when a tiny input expands into a large
file. Returned chunks own their bytes; consume the iterator fully before the
next push. Known-size one-shot results above 4 MiB also use this bounded WASM
output path, copying directly into the final JS array. The aggregate `push()`
API remains available for callers that need a single output buffer.
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

Run `node codecs/zstd/benchmark-decode.mjs` for the Node.js SIMD/scalar streaming
decoder benchmark. It checks structured and incompressible frames, with and
without declared content sizes. Each sample measures the first frame (output
buffer growth) and a consecutive frame (capacity reuse), excluding JS input and
output copies. Pass `--baseline <directory>` to alternate measurements against
saved artifacts; `--size-mib` and `--samples` control the workload.

The browser API intentionally caps compression at level 4. The build retains
the fast, double-fast and greedy compressors required by levels 1 through 4,
and excludes the lazy and binary-tree/optimal compression strategies used by
higher levels. This only reduces encoding capabilities: the official decoder
remains able to read standard zstd frames produced at every compression level.
