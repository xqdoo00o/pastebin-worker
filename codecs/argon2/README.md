# Monocypher Argon2 WASM

This directory builds the Argon2id verifier used by Monocypher as a small Emscripten WebAssembly module. The build uses
`-msimd128` (plus LTO and vectorization). The upstream source is pinned in `build.mjs` and fetched into `third_party/`
on demand.

```console
$ pnpm build:argon2
```

The generated files are written to `dist/` and are intentionally ignored by Git. The JavaScript API exposes an
asynchronous default initializer, `create_password_hash(password, salt)`, and `verify_password_hash(password, hash)`.
For predictable Worker resource use, verification accepts encoded Argon2id hashes up to 64 MiB (`m=65536`), six passes,
and four lanes; it also enforces Argon2's `m >= 8 * p` requirement.
