/** Worker construction lives behind this boundary so the standalone receiver
 * can replace URL-based module workers with self-contained constructors. */
export function createOpticalDecodeWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
}

export function createFountainWorker(): Worker {
  return new Worker(new URL("./fountain-worker.ts", import.meta.url), { type: "module" })
}

export function createApngParserWorker(): Worker {
  return new Worker(new URL("./apng-parser-worker.ts", import.meta.url), { type: "module" })
}

export function createCaptureWorker(): Worker {
  return new Worker(new URL("./capture-worker.ts", import.meta.url), { type: "module" })
}
