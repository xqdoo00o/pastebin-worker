/** Trigger a browser download for a URL that is owned by the caller. */
export function triggerUrlDownload(url: string, filename: string): void {
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** Download a Blob and release its temporary URL shortly afterwards. */
export function downloadBlob(blob: Blob, filename: string, revokeAfterMs = 1000): void {
  const url = URL.createObjectURL(blob)
  triggerUrlDownload(url, filename)
  window.setTimeout(() => URL.revokeObjectURL?.(url), revokeAfterMs)
}
