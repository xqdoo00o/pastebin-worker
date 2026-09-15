# NanoRQ WebAssembly codec

This directory builds the pinned NanoRQ RFC 6330 implementation as an
Emscripten WebAssembly SIMD128 codec. The build keeps the ignored NanoRQ
checkout pristine and applies its patches in a disposable copy under `build/`.
The pinned Project Nayuki C QR generator is vendored under `src/`, so it does
not require a separate checkout. Its QR Reed-Solomon hot path fuses the
remainder shift with NanoRQ's GF(256) AXPY implementation, using two complete
SIMD lanes or the scalar multiplication table. Streaming encoders cache the RS
divisor, fixed-mask symbol template, and codeword module traversal for their
locked version. Byte segments are appended a byte at a time even at unaligned
bit offsets. This module is the production optical sender and receiver backend;
the public fountain-code API remains named RaptorQ because the wire protocol is
RFC 6330.

Run `pnpm build:nanorq` from the repository root.

Both NanoRQ and the Optical codec use the shared toolchain under
`codecs/.tools/`. Run `pnpm setup:emscripten` once when it is not already
available.

When the ignored NanoRQ checkout is absent, the first stale build fetches its
fixed revision from GitHub. The vendored QR source is always available locally.
A cache hit through `pnpm ensure:nanorq` does not need Git, the NanoRQ checkout,
or the Emscripten toolchain.
