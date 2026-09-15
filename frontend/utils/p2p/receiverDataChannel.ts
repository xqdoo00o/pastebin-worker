import { asError } from "../errors.js"

interface ReceiverDataChannelHandlers {
  isClosed: () => boolean
  onOpen: (channel: RTCDataChannel, isCurrent: () => boolean) => void
  onMessage: (data: MessageEvent["data"], channel: RTCDataChannel, isCurrent: () => boolean) => Promise<void>
  onMessageError: (error: Error, channel: RTCDataChannel, isCurrent: () => boolean) => Promise<void>
  onDisconnect: (channel: RTCDataChannel, isCurrent: () => boolean) => void
}

/** Owns replacement, stale-event guards, and serialized message delivery for
 * the receiver's single active RTC data channel. */
export class ReceiverDataChannel {
  private generation = 0
  private queue = Promise.resolve()
  current: RTCDataChannel | undefined

  attach(channel: RTCDataChannel, handlers: ReceiverDataChannelHandlers): void {
    if (handlers.isClosed()) {
      channel.close()
      return
    }
    this.detach(this.current !== channel)
    this.current = channel
    const generation = this.generation
    const isCurrent = () => !handlers.isClosed() && this.generation === generation && this.current === channel

    channel.binaryType = "arraybuffer"
    channel.onopen = () => {
      if (isCurrent()) handlers.onOpen(channel, isCurrent)
    }
    channel.onmessage = (event) => {
      if (!isCurrent()) return
      this.queue = this.queue
        .then(() => handlers.onMessage(event.data, channel, isCurrent))
        .catch((error) => (isCurrent() ? handlers.onMessageError(asError(error), channel, isCurrent) : undefined))
    }
    channel.onclose = () => {
      if (isCurrent()) handlers.onDisconnect(channel, isCurrent)
    }
    channel.onerror = () => {
      if (isCurrent()) handlers.onDisconnect(channel, isCurrent)
    }
  }

  detach(close = false): RTCDataChannel | undefined {
    this.generation += 1
    this.queue = Promise.resolve()
    const channel = this.current
    this.current = undefined
    if (!channel) return undefined
    channel.onopen = null
    channel.onmessage = null
    channel.onclose = null
    channel.onerror = null
    if (close) channel.close()
    return channel
  }
}
