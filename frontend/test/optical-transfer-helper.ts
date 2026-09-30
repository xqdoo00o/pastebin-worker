import {
  prepareOpticalPayload,
  type OpticalMemoryFile,
  type OpticalTransferParts,
  type PrepareOpticalPayloadOptions,
} from "../optical/send/prepared-transfer.js"
import { MAX_FILE_BYTES, type PackedOpticalFile } from "../optical/shared/protocol.js"

type PrepareOpticalTransferOptions = PrepareOpticalPayloadOptions & { partPayloadSize?: number }
type PreparedOpticalTransfer = OpticalTransferParts & { cleanup(): Promise<void> }

/** Convenience owner for callers that need only one partition of a file. */
export async function prepareOpticalTransfer(
  file: File | OpticalMemoryFile,
  { partPayloadSize = MAX_FILE_BYTES, ...options }: PrepareOpticalTransferOptions = {},
): Promise<PreparedOpticalTransfer> {
  const payload = await prepareOpticalPayload(file, options)
  try {
    return { ...(await payload.partition(partPayloadSize)), cleanup: () => payload.cleanup() }
  } catch (error) {
    await payload.cleanup()
    throw error
  }
}

export async function prepareOpticalParts(
  name: string,
  type: string,
  bytes: Uint8Array,
  partPayloadSize = MAX_FILE_BYTES,
): Promise<PackedOpticalFile[]> {
  const transfer = await prepareOpticalTransfer(
    { name, type, data: bytes.slice().buffer },
    { partPayloadSize, opfsThreshold: Number.MAX_SAFE_INTEGER },
  )
  try {
    return await Promise.all(Array.from({ length: transfer.summary.partCount }, (_, index) => transfer.getPart(index)))
  } finally {
    await transfer.cleanup()
  }
}
