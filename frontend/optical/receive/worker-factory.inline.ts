import OpticalDecodeWorker from "./worker.ts?worker&inline"
import FountainWorker from "./fountain-worker.ts?worker&inline"
import ApngParserWorker from "./apng-parser-worker.ts?worker&inline"
import CaptureWorker from "./capture-worker.ts?worker&inline"

export function createOpticalDecodeWorker(): Worker {
  return new OpticalDecodeWorker()
}

export function createFountainWorker(): Worker {
  return new FountainWorker()
}

export function createApngParserWorker(): Worker {
  return new ApngParserWorker()
}

export function createCaptureWorker(): Worker {
  return new CaptureWorker()
}
