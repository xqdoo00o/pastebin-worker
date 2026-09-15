export function verify_password_hash(password: string, encoded_hash: string): boolean
export function create_password_hash(password: string, salt: BufferSource): string
export type InitInput = RequestInfo | URL | BufferSource | WebAssembly.Module
export default function init(input?: InitInput | Promise<InitInput>): Promise<unknown>
