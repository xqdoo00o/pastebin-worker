import type { P2PCreateResponse, P2PUpdateResponse, PublicEnv } from "../../../shared/interfaces.js"
import { ErrorWithTitle } from "../errors.js"

interface CreateRoomOptions {
  expire: string
  maxTransfers: string
  isPrivate: boolean
  signal?: AbortSignal
}

export async function createP2PRoom(
  config: PublicEnv,
  { expire, maxTransfers, isPrivate, signal }: CreateRoomOptions,
): Promise<P2PCreateResponse> {
  const response = await fetch(new URL("/p2p/create", config.DEPLOY_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expire, maxTransfers, isPrivate }),
    signal,
  })
  if (!response.ok) throw new ErrorWithTitle("Error on Creating P2P Share", await response.text())
  return await response.json()
}

interface UpdateRoomOptions {
  expire: string
  maxTransfers: string
  signal?: AbortSignal
}

export async function updateP2PRoom(
  config: PublicEnv,
  room: Pick<P2PCreateResponse, "name" | "senderToken">,
  { expire, maxTransfers, signal }: UpdateRoomOptions,
): Promise<P2PUpdateResponse> {
  const response = await fetch(new URL(`/p2p/update/${encodeURIComponent(room.name)}`, config.DEPLOY_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderToken: room.senderToken, expire, maxTransfers }),
    signal,
  })
  if (!response.ok) throw new ErrorWithTitle("Error on Updating P2P Share", await response.text())
  return await response.json()
}
