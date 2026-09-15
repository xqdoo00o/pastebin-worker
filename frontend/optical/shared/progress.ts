/**
 * Distinct repair frames per RFC 6330 source symbol a stream needs.
 *
 * RaptorQ reconstructs with K symbols in most cases. K+2 already has failure
 * probability about 1/256^3; use the larger of that rank margin and 2% so ETA
 * does not promise exact-K completion for tiny objects.
 */
export function expectedRaptorQOverhead(sourceSymbols: number): number {
  if (sourceSymbols <= 1) return 1
  return (sourceSymbols + Math.max(2, Math.ceil(sourceSymbols * 0.02))) / sourceSymbols
}

export interface TransferProgressEstimate {
  fraction: number
  expectedFrames: number
  etaSeconds?: number
  phase: "collecting" | "decoding"
}

export function estimateTransferProgress(
  sourceSymbols: number,
  uniqueFrames: number,
  elapsedSeconds: number,
): TransferProgressEstimate {
  const minimumFrames = Math.max(1, sourceSymbols)
  const expectedFrames = Math.max(minimumFrames + 1, Math.ceil(minimumFrames * expectedRaptorQOverhead(minimumFrames)))
  const expectedRedundancy = expectedFrames - minimumFrames
  const receivedFrames = Math.max(0, uniqueFrames)

  // K is the decoder's real threshold, so map collection linearly to 99%.
  // Once K has arrived, stay at 99% until NanoRQ proves the matrix is full
  // rank and the recovered container tag matches; only that completion path owns
  // 100%. There is no truthful progressive "solved symbol" count in between.
  const fraction = Math.min(0.99, 0.99 * (receivedFrames / minimumFrames))
  const phase = receivedFrames < minimumFrames ? "collecting" : "decoding"
  const rate = elapsedSeconds > 0 ? receivedFrames / elapsedSeconds : 0

  // Past the expected frame count the stream is running long — poor light,
  // motion blur, a camera that won't hold focus. That is exactly when someone
  // is staring at the bar wondering whether it has stalled, so keep quoting a
  // time instead of going silent: extend the target a tenth of the stream at
  // a time. (The nominal redundancy is only 2%, which as a step
  // size would quote a perpetual "about 1s" — a floor keeps the steps honest.)
  const overshoot = receivedFrames - expectedFrames
  const step = Math.max(expectedRedundancy, Math.ceil(minimumFrames / 10))
  const target = overshoot < 0 ? expectedFrames : expectedFrames + step * (Math.floor(overshoot / step) + 1)
  const etaSeconds =
    receivedFrames >= 3 && elapsedSeconds >= 1 && rate > 0 ? (target - receivedFrames) / rate : undefined
  return { fraction, expectedFrames, etaSeconds, phase }
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(1, Math.ceil(seconds))
  if (rounded < 60) return `${rounded}s`
  const minutes = Math.floor(rounded / 60)
  const remainder = rounded % 60
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}
