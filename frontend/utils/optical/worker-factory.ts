/** Worker construction lives behind this small boundary so specialized builds
 * can swap in bundled constructors without rewriting hook source code. */
export function createOpticalSenderWorker(): Worker {
  return new Worker(new URL("../../optical/send/worker.ts", import.meta.url), { type: "module" })
}

export function createApngExportWorker(): Worker {
  return new Worker(new URL("../../optical/send/apng-worker.ts", import.meta.url), { type: "module" })
}
