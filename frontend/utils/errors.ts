export class ErrorWithTitle extends Error {
  public title: string

  constructor(title: string, msg: string) {
    super(msg)
    this.title = title
  }
}

export class FileReadError extends Error {
  constructor(filename: string, cause?: unknown) {
    super(
      `Could not read "${filename}". It may have been moved, deleted, or changed since it was selected. ` +
        "Select the file again and retry.",
    )
    this.name = "FileReadError"
    if (cause !== undefined) Object.defineProperty(this, "cause", { value: cause, configurable: true })
  }
}

export function isFileReadError(error: unknown): error is Error {
  return error instanceof Error && error.name === "FileReadError"
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error))
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
}

export function abortReason(signal: AbortSignal, fallback = "The operation was aborted"): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException(fallback, "AbortError")
}
