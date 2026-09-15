// This file contains things shared with frontend

export type PasteLocation = "KV" | "R2"

export interface OriginalFileInfo {
  name: string
  sizeBytes: number
}

export interface MetaResponse {
  lastModifiedAt: string
  createdAt: string
  expireAt: string
  sizeBytes: number
  location: PasteLocation
  remainingReads?: number
  filename?: string
  filenames?: OriginalFileInfo[]
  mimeType?: string
  highlightLanguage?: string
  encryptionScheme?: string
}

export interface PasteResponse extends MetaResponse {
  url: string
  manageUrl: string
  expirationSeconds: number
}

const PUBLIC_ENV_KEYS = [
  "DEPLOY_URL",
  "REPO",
  "MAX_EXPIRATION",
  "DEFAULT_READS",
  "DEFAULT_EXPIRATION",
  "DEFAULT_TAB",
  "DEFAULT_ARCHIVE_COMPRESSION",
  "DEFAULT_P2P_EXPIRATION",
  "MAX_P2P_EXPIRATION",
  "DEFAULT_P2P_TRANSFERS",
  "DEFAULT_P2P_VERIFY",
  "DEFAULT_TRANSFER_METHOD",
  "DEFAULT_LINK_TYPE",
  "DEFAULT_E2E_ENCRYPTION",
  "DEFAULT_QR_TX_FPS",
  "DEFAULT_QR_FRAME_BYTES",
  "DEFAULT_QR_ECC",
  "DEFAULT_QR_LAYOUT",
  "INDEX_PAGE_TITLE",
  "R2_MAX_ALLOWED",
  "DISALLOWED_MIME_FOR_PASTE",
] as const satisfies readonly (keyof Env)[]

export type PublicEnv = Pick<Env, (typeof PUBLIC_ENV_KEYS)[number]>

export function pickPublicEnv(env: Env): PublicEnv {
  return Object.fromEntries(PUBLIC_ENV_KEYS.map((key) => [key, env[key]])) as PublicEnv
}

export interface P2PCreateResponse {
  name: string
  url: string
  displayUrl: string
  senderToken: string
  expireAt: string
  expirationSeconds: number
}

export interface P2PUpdateResponse {
  expireAt: string
  expirationSeconds: number
  maxTransfers: number
  joinable: boolean
  pairedReceivers: number
  successfulReceivers: number
}

export interface P2PIceServer {
  urls: string | string[]
  username?: string
  credential?: string
  credentialType?: "password" | "oauth"
}

export interface MPUCreateResponse {
  name: string
  key: string
  uploadId: string
}

export interface SerializedPasteData {
  content: string
  contentType?: string
  metadata: MetaResponse
  name: string
  isBinary: boolean
  guessedEncoding: string | null
}

declare global {
  interface Window {
    __PASTE_DATA__?: SerializedPasteData
  }
}
