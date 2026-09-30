# NanoRQ WebAssembly codec

This directory builds the pinned NanoRQ RFC 6330 implementation as an
Emscripten WebAssembly SIMD128 codec. The build keeps the ignored NanoRQ
checkout pristine and applies its patches in a disposable copy under `build/`.
The pinned Project Nayuki C QR generator is vendored under `src/`, so it does
not require a separate checkout. Streaming QR encoders cache the RS divisor and
its 256 coefficient products in an 8 KiB table. The SIMD remainder loop keeps
its one or two lanes in registers; the scalar loop processes only the actual
ECC degree. The uncached path retains the fused shift/GF(256) kernel, which also
builds the product cache. The SIMD QR path does not initialize the scalar table.
Streaming encoders also cache the
fixed-mask symbol template and codeword module traversal for their
locked version. The layout cache is allocated for the version chosen by the
first frame and rebuilt if the version changes. Module offsets remain 16-bit
even at v48; the mask is stored in the symbol template. Changing only ECC
updates format bits without rebuilding the traversal. Byte segments are appended a
byte at a time even at unaligned bit offsets; padding uses aligned byte writes. This module is the
production optical sender and receiver backend;
the public fountain-code API remains named RaptorQ because the wire protocol is
RFC 6330.

The `0004-qr-v48-profile.patch` adds the transfer-only v48 ECC layout used by
the vendored QR generator. V48 is 209×209 modules and carries up to 4143,
2953, 2331, or 1450 bytes at ECC L, M, Q, or H respectively.

Fountain encoders release their preparation, inversion and operation-schedule
arenas after computing the intermediate symbols. Decoder retries retain and
grow their inversion/schedule buffers, while rebuilding the packet-dependent
matrix for each attempt. All retained buffers are released with the handle.

Run `pnpm build:nanorq` from the repository root.
Run `node codecs/nanorq/benchmark-qr.mjs` after building to measure warm
fixed-version QR encoding for the SIMD and scalar variants.
Run `node codecs/nanorq/benchmark-fountain.mjs` to measure fountain-code
preparation, repair generation, and recovery with deterministic packet loss.

Both NanoRQ and the Optical codec use the shared toolchain under
`codecs/.tools/`. Run `pnpm setup:emscripten` once when it is not already
available.

When the ignored NanoRQ checkout is absent, the first stale build fetches its
fixed revision from GitHub. The vendored QR source is always available locally.
A cache hit through `pnpm ensure:nanorq` does not need Git, the NanoRQ checkout,
or the Emscripten toolchain.
