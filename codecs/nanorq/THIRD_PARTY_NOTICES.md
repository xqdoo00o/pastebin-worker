# Third-party notices

This adapter and its generated WebAssembly binary include a patched copy of
NanoRQ by Joseph Calderon, licensed under the MIT License.

- Source: https://github.com/sleepybishop/nanorq
- Revision: `6295a9525893b9a757dd57431db76fc6ecceafac`
- Local changes: `patches/nanorq/0001-wasm-simd128-backend.patch` and
  `patches/nanorq/0002-wasm-simd-unroll-direct-dispatch.patch`, and
  `patches/nanorq/0003-qrcodegen-rs-kernel.patch`

The generated WebAssembly binary also includes Project Nayuki's QR Code
generator, licensed under the MIT License.

- Source: https://github.com/nayuki/QR-Code-generator
- Revision: `3c6d0b3cefb4e049dc337e82237c9644399716a8`
- Vendored files: `src/qrcodegen.c`, `src/qrcodegen.h`, and
  `src/qrcodegen.LICENSE`
- Local changes in `src/qrcodegen.c`: its QR Reed-Solomon remainder loop
  uses NanoRQ's fused GF(256) shift/AXPY backend for SIMD and scalar builds;
  byte-segment copying is optimized; and fixed-mask streaming encoders cache
  the RS divisor, symbol template, and codeword module traversal.
