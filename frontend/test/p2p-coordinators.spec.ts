import { afterEach, describe, expect, it, vi } from "vitest"

import type { PublicEnv } from "../../shared/interfaces.js"
import { ReceiverConnectionRecovery } from "../utils/p2p/receiverRecovery.js"
import { ReceiverStorageCoordinator } from "../utils/p2p/receiverStorageCoordinator.js"
import { ReceiverStorageSession } from "../utils/p2p/receiverSession.js"
import { createP2PRoom, updateP2PRoom } from "../utils/p2p/roomClient.js"
import { SenderPeerRecoveryCoordinator } from "../utils/p2p/senderRecovery.js"
import { SenderVerificationService } from "../utils/p2p/senderVerification.js"
import { createFileVersion, type SenderPeerState } from "../utils/p2p/senderState.js"
import type { ReceivedStore } from "../utils/p2p/receivedStorage.js"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("P2P room client", () => {
  it("creates and updates a room through one encoded HTTP boundary", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "room/name", senderToken: "token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ expireAt: 10, expirationSeconds: 20, joinable: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const config = { DEPLOY_URL: "https://example.test/base" } as PublicEnv

    const room = await createP2PRoom(config, {
      expire: "1h",
      maxTransfers: "2",
      isPrivate: true,
    })
    await updateP2PRoom(config, room, { expire: "2h", maxTransfers: "3" })

    expect(fetchMock.mock.calls[0][0]).toEqual(new URL("https://example.test/p2p/create"))
    expect(fetchMock.mock.calls[1][0]).toEqual(new URL("https://example.test/p2p/update/room%2Fname"))
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      expire: "1h",
      maxTransfers: "2",
      isPrivate: true,
    })
  })
})

describe("P2P sender coordinators", () => {
  it("owns streamed verification-manifest publication", async () => {
    const service = new SenderVerificationService()
    const version = createFileVersion(new File(["data"], "file.bin"), true, 0)
    const producer = service.reserveStreamed(version)
    expect(producer).toBeDefined()

    service.publishStreamed(version, producer!, { blockSize: 4, hashes: ["hash"] })

    await expect(producer!.promise).resolves.toEqual({ blockSize: 4, hashes: ["hash"] })
    expect(await service.manifest(version)).toEqual({ blockSize: 4, hashes: ["hash"] })
  })

  it("owns peer recovery timers and state transitions", async () => {
    vi.useFakeTimers()
    const peer = {
      peerId: "peer-1",
      transferState: { kind: "idle" },
      recoveryState: "idle",
      isWaitingForResume: false,
      hasOpenedDataChannel: false,
      isConnected: true,
      operationGeneration: 0,
      speedBytesPerSecond: 0,
      connectionRoute: "direct",
    } as SenderPeerState
    const peers = new Map([[peer.peerId, peer]])
    const renegotiate = vi.fn(() => Promise.resolve())
    const onStateChanged = vi.fn()
    const coordinator = new SenderPeerRecoveryCoordinator({
      peers,
      isClosed: () => false,
      canNegotiate: () => true,
      renegotiate,
      sendSignal: () => true,
      onStateChanged,
      onError: vi.fn(),
    })

    coordinator.schedule(peer.peerId, { immediate: true })
    expect(peer.recoveryState).toBe("recovering")
    expect(peer.status).toContain("pairing failed")
    await vi.advanceTimersByTimeAsync(0)
    expect(renegotiate).toHaveBeenCalledOnce()
    expect(onStateChanged).toHaveBeenCalledOnce()
    coordinator.dispose()
  })
})

describe("P2P receiver coordinators", () => {
  it("owns reconnect intent, signaling deferral, and retry tokens", async () => {
    vi.useFakeTimers()
    const sendSignal = vi.fn(() => true)
    const onRecoveringChange = vi.fn()
    const retryTokens: (string | undefined)[] = []
    const recovery = new ReceiverConnectionRecovery({
      initialRetryToken: "retry-1",
      isClosed: () => false,
      isComplete: () => false,
      isSignalingReady: () => true,
      isSenderSignalingAvailable: () => true,
      recoveryStatus: () => "Recovering",
      waitingForSignalingStatus: () => "Waiting",
      sendSignal,
      onStatus: vi.fn(),
      onRecoveringChange,
      onRetryTokenChange: (token) => retryTokens.push(token),
    })

    recovery.request(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sendSignal).toHaveBeenCalledWith({ type: "peer-reconnect-request", retryToken: "retry-1" })
    expect(recovery.active).toBe(true)

    recovery.finish()
    expect(recovery.active).toBe(false)
    expect(recovery.retryToken).toBeUndefined()
    expect(onRecoveringChange.mock.calls).toEqual([[true], [false]])
    expect(retryTokens).toEqual([undefined])
  })

  it("serializes persistent writes and registers checkpoints", async () => {
    const { store, append, checkpoint } = mockReceivedStore("persistent")
    const storage = new ReceiverStorageSession(
      {
        canRestore: () => true,
        create: vi.fn(() => Promise.resolve(store)),
        restore: vi.fn(),
      },
      "storage-1",
    )
    const sent: unknown[] = []
    const coordinator = new ReceiverStorageCoordinator({
      roomName: "room",
      peerId: "peer-1",
      storage,
      sendSignal: (message) => {
        sent.push(message)
        return true
      },
    })
    const meta = {
      revision: "revision-1",
      name: "file.bin",
      size: 8,
      type: "application/octet-stream",
      lastModified: 0,
      senderBrowser: "Test",
      verifyTransfer: true,
    }

    await coordinator.prepare(meta, false, () => true, vi.fn())
    await coordinator.enqueue(async () => {
      await coordinator.append(0, new ArrayBuffer(4))
      await coordinator.checkpointData({ meta, receivedBytes: 4, completedHashes: ["hash"] }, true)
    })

    expect(append).toHaveBeenCalledOnce()
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(coordinator.checkpoint).toMatchObject({ roomName: "room", peerId: "peer-1", receivedBytes: 4 })
    expect(sent).toContainEqual({ type: "transfer-checkpoint" })
  })
})

function mockReceivedStore(kind: ReceivedStore["kind"]) {
  const append = vi.fn(() => Promise.resolve())
  const checkpoint = vi.fn(() => Promise.resolve())
  const store: ReceivedStore = {
    kind,
    append,
    replaceBlock: vi.fn(() => Promise.resolve()),
    checkpoint,
    file: vi.fn(() => Promise.resolve(new File([], "file.bin"))),
    verificationParts: vi.fn(),
    preserve: vi.fn(() => Promise.resolve()),
    queueDeletion: vi.fn(),
    discard: vi.fn(() => Promise.resolve()),
  }
  return { store, append, checkpoint }
}
