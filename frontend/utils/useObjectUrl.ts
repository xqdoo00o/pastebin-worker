import { useEffect, useState } from "react"

/** Own one preview URL for the current Blob, including replacement and unmount. */
export function useObjectUrl(blob: Blob | undefined): string {
  const [resource, setResource] = useState<{ blob: Blob; url: string }>()
  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") {
      setResource(undefined)
      return
    }
    const url = URL.createObjectURL(blob)
    setResource({ blob, url })
    return () => URL.revokeObjectURL?.(url)
  }, [blob])
  return resource?.blob === blob ? (resource?.url ?? "") : ""
}
