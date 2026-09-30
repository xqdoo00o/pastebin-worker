import { isUuid } from "../../shared/verify.js"
import type { P2PIceServer } from "../../shared/interfaces.js"

export const EXPIRES_AT_KEY = "expiresAt"
export const ICE_SERVERS_KEY = "iceServers"
export const ICE_SERVERS_EXPIRES_AT_KEY = "iceServersExpiresAt"
export const MAX_TRANSFERS_KEY = "maxTransfers"
export const SENDER_TOKEN_KEY = "senderToken"
export const RECEIVER_CLEANUP_AT_KEY = "receiverCleanupAt"
export const PAIRED_RECEIVER_COUNT_KEY = "pairedReceiverCount"
export const SUCCESSFUL_RECEIVER_COUNT_KEY = "successfulReceiverCount"

const RECEIVER_STATE_KEY_PREFIX = "receiverState:"
type ReceiverMembershipState = "paired" | "resumable" | "successful"

export interface P2PRoomStatus {
  active: boolean
  joinable: boolean
  hasSender: boolean
  hasReceiver: boolean
}

export interface P2PRoomInit {
  iceServers?: P2PIceServer[]
  iceServersExpiresAt?: number
  senderToken: string
  expiresAt: number
  maxTransfers: number
}

export interface P2PRoomUpdate {
  senderToken: string
  expiresAt: number
  expirationSeconds: number
  maxTransfers: number
}

export function storedReceiverDeadlines(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => isUuid(entry[0]) && Number.isFinite(entry[1])),
  )
}

export function storedRoomExpiresAt(stored: Map<string, unknown>): number {
  const expiresAt = stored.get(EXPIRES_AT_KEY)
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : 0
}

interface MembershipSnapshot {
  maxTransfers: number
  pairedCount: number
  successfulCount: number
  peerState?: ReceiverMembershipState
}

function storedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function receiverStateKey(peerId: string): string {
  return `${RECEIVER_STATE_KEY_PREFIX}${peerId}`
}

/** Constant-size counts and one key per receiver. */
export class P2PRoomMembershipStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  private async snapshot(peerId?: string): Promise<MembershipSnapshot> {
    const stored = await this.storage.get([
      MAX_TRANSFERS_KEY,
      PAIRED_RECEIVER_COUNT_KEY,
      SUCCESSFUL_RECEIVER_COUNT_KEY,
      ...(peerId ? [receiverStateKey(peerId)] : []),
    ])
    const maxTransfers = storedCount(stored.get(MAX_TRANSFERS_KEY))
    const state = peerId ? stored.get(receiverStateKey(peerId)) : undefined
    return {
      maxTransfers,
      pairedCount: storedCount(stored.get(PAIRED_RECEIVER_COUNT_KEY)),
      successfulCount: storedCount(stored.get(SUCCESSFUL_RECEIVER_COUNT_KEY)),
      peerState: state === "paired" || state === "resumable" || state === "successful" ? state : undefined,
    }
  }

  private async setPeerState(
    snapshot: MembershipSnapshot,
    peerId: string,
    nextState: ReceiverMembershipState | undefined,
  ): Promise<void> {
    if (snapshot.peerState === nextState) return
    const pairedDelta = Number(nextState !== undefined) - Number(snapshot.peerState !== undefined)
    const successfulDelta = Number(nextState === "successful") - Number(snapshot.peerState === "successful")
    if (nextState === undefined) await this.storage.delete(receiverStateKey(peerId))
    const updates: Record<string, number | ReceiverMembershipState> = {}
    if (nextState !== undefined) updates[receiverStateKey(peerId)] = nextState
    if (pairedDelta !== 0) updates[PAIRED_RECEIVER_COUNT_KEY] = snapshot.pairedCount + pairedDelta
    if (successfulDelta !== 0) updates[SUCCESSFUL_RECEIVER_COUNT_KEY] = snapshot.successfulCount + successfulDelta
    if (Object.keys(updates).length > 0) await this.storage.put(updates)
  }

  async summary(): Promise<{ maxTransfers: number; pairedReceivers: number; successfulReceivers: number }> {
    const snapshot = await this.snapshot()
    return {
      maxTransfers: snapshot.maxTransfers,
      pairedReceivers: snapshot.pairedCount,
      successfulReceivers: snapshot.successfulCount,
    }
  }

  async admission(peerId: string): Promise<{ successful: boolean; resumable: boolean; canAdd: boolean }> {
    const snapshot = await this.snapshot(peerId)
    const { peerState, maxTransfers, pairedCount } = snapshot
    return {
      successful: peerState === "successful",
      resumable: peerState === "resumable",
      canAdd:
        peerState === "resumable" || (peerState === undefined && (maxTransfers === 0 || pairedCount < maxTransfers)),
    }
  }

  async recordPaired(peerId: string): Promise<boolean> {
    const snapshot = await this.snapshot(peerId)
    if (snapshot.peerState === "successful") return false
    if (snapshot.peerState !== undefined) return true
    if (snapshot.maxTransfers > 0 && snapshot.pairedCount >= snapshot.maxTransfers) return false
    await this.setPeerState(snapshot, peerId, "paired")
    return true
  }

  async recordSuccessful(peerId: string, isConnected: boolean): Promise<{ accepted: boolean; limitReached: boolean }> {
    const snapshot = await this.snapshot(peerId)
    const limitReached = snapshot.maxTransfers > 0 && snapshot.pairedCount >= snapshot.maxTransfers
    if (snapshot.peerState === "successful") return { accepted: true, limitReached }
    if (snapshot.peerState === undefined && (!isConnected || limitReached)) {
      return { accepted: false, limitReached: !isConnected ? false : limitReached }
    }
    await this.setPeerState(snapshot, peerId, "successful")
    return {
      accepted: true,
      limitReached:
        snapshot.maxTransfers > 0 &&
        snapshot.pairedCount + Number(snapshot.peerState === undefined) >= snapshot.maxTransfers,
    }
  }

  async recordResumable(peerId: string): Promise<boolean> {
    const snapshot = await this.snapshot(peerId)
    if (snapshot.peerState !== "paired" && snapshot.peerState !== "resumable") return false
    await this.setPeerState(snapshot, peerId, "resumable")
    return true
  }

  async clearResumable(peerId: string): Promise<void> {
    const snapshot = await this.snapshot(peerId)
    if (snapshot.peerState === "resumable") await this.setPeerState(snapshot, peerId, "paired")
  }

  async release(peerId: string, force = false): Promise<boolean> {
    const snapshot = await this.snapshot(peerId)
    if (snapshot.peerState === "successful") return false
    if (!force && snapshot.peerState === "resumable") return true
    if (snapshot.peerState !== undefined) await this.setPeerState(snapshot, peerId, undefined)
    return false
  }
}
