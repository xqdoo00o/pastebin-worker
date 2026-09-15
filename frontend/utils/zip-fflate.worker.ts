import { initWorker } from "@zip.js/zip.js/worker"
import { Deflate, type DeflateOptions } from "fflate"

const FORMAT_DEFLATE_RAW = "deflate-raw"

class FflateCompressionStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: string, { level }: { level?: number } = {}) {
    if (format !== FORMAT_DEFLATE_RAW) throw new TypeError(`Unsupported compression format: ${format}`)
    if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 9)) {
      throw new RangeError(`Unsupported compression level: ${level}`)
    }
    const codec = new Deflate(level === undefined ? {} : { level: level as DeflateOptions["level"] })
    super({
      start(controller) {
        codec.ondata = (chunk) => {
          if (chunk.length) controller.enqueue(chunk)
        }
      },
      transform(chunk) {
        codec.push(chunk)
      },
      flush() {
        codec.push(new Uint8Array(), true)
      },
    })
  }
}

initWorker({ CompressionStreamFallback: FflateCompressionStream })
