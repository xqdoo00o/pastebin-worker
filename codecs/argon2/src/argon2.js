import createArgon2Module from "./argon2_bg.js"

let wasm
let wasmReady
const encoder = new TextEncoder()
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function initialized() {
  if (!wasm) throw new Error("Argon2 WASM has not been initialized. Await the default initializer first.")
  return wasm
}

async function instantiate(module) {
  const result = await createArgon2Module({
    instantiateWasm(imports, receiveInstance) {
      const instance = new WebAssembly.Instance(module, imports)
      receiveInstance(instance, module)
      return instance.exports
    },
  })
  wasm = result
  return wasm
}

function encodeBase64(bytes) {
  let result = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index
    const first = bytes[index]
    const second = remaining > 1 ? bytes[index + 1] : 0
    const third = remaining > 2 ? bytes[index + 2] : 0
    result += base64Alphabet[first >> 2]
    result += base64Alphabet[((first & 3) << 4) | (second >> 4)]
    if (remaining > 1) result += base64Alphabet[((second & 15) << 2) | (third >> 6)]
    if (remaining > 2) result += base64Alphabet[third & 63]
  }
  return result
}

function byteView(value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(value)
}

async function initialize(input) {
  const source = await input
  if (source instanceof WebAssembly.Module) return instantiate(source)
  if (ArrayBuffer.isView(source) || source instanceof ArrayBuffer)
    return instantiate(new WebAssembly.Module(source))
  const response = await fetch(source ?? new URL("argon2_bg.wasm", import.meta.url))
  if (!response.ok) throw new Error(`Unable to load Argon2 WASM: ${response.status} ${response.statusText}`)
  return instantiate(new WebAssembly.Module(await response.arrayBuffer()))
}

export default function init(input) {
  if (wasm) return Promise.resolve(wasm)
  if (!wasmReady) {
    wasmReady = initialize(input).catch((error) => {
      wasmReady = undefined
      throw error
    })
  }
  return wasmReady
}

export function verify_password_hash(password, encoded_hash) {
  const module = initialized()
  const passwordBytes = encoder.encode(password)
  const hashBytes = encoder.encode(encoded_hash)
  const passwordPointer = module._malloc(passwordBytes.length || 1)
  const hashPointer = module._malloc(hashBytes.length + 1)
  if (!passwordPointer || !hashPointer) {
    if (passwordPointer) module._free(passwordPointer)
    if (hashPointer) module._free(hashPointer)
    throw new Error("Argon2 WASM could not allocate input buffers.")
  }
  try {
    module.HEAPU8.set(passwordBytes, passwordPointer)
    module.HEAPU8.set(hashBytes, hashPointer)
    module.HEAPU8[hashPointer + hashBytes.length] = 0
    return module._argon2_monocypher_verify(passwordPointer, passwordBytes.length, hashPointer) !== 0
  } finally {
    module._free(passwordPointer)
    module._free(hashPointer)
  }
}

export function create_password_hash(password, salt) {
  const module = initialized()
  const passwordBytes = encoder.encode(password)
  const saltBytes = byteView(salt)
  if (saltBytes.length === 0) throw new Error("Argon2 salt must not be empty.")
  const passwordPointer = module._malloc(passwordBytes.length || 1)
  const saltPointer = module._malloc(saltBytes.length)
  const outputPointer = module._malloc(32)
  if (!passwordPointer || !saltPointer || !outputPointer) {
    if (passwordPointer) module._free(passwordPointer)
    if (saltPointer) module._free(saltPointer)
    if (outputPointer) module._free(outputPointer)
    throw new Error("Argon2 WASM could not allocate input buffers.")
  }
  try {
    module.HEAPU8.set(passwordBytes, passwordPointer)
    module.HEAPU8.set(saltBytes, saltPointer)
    if (
      !module._argon2_monocypher_hash(
        passwordPointer,
        passwordBytes.length,
        saltPointer,
        saltBytes.length,
        outputPointer,
      )
    )
      throw new Error("Argon2 WASM failed to derive a password hash.")
    const hash = module.HEAPU8.slice(outputPointer, outputPointer + 32)
    return `$argon2id$v=19$m=8192,t=2,p=1$${encodeBase64(saltBytes)}$${encodeBase64(hash)}`
  } finally {
    module._free(passwordPointer)
    module._free(saltPointer)
    module._free(outputPointer)
  }
}
