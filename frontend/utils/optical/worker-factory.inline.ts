import SenderWorker from "../../optical/send/worker.ts?worker&inline"
import ApngWorker from "../../optical/send/apng-worker.ts?worker&inline"

export function createOpticalSenderWorker(): Worker {
  return new SenderWorker()
}

export function createApngExportWorker(): Worker {
  return new ApngWorker()
}
