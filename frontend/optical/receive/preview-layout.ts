/** Keeps the visual preview aligned with the full camera/screen frame sent to the decoder. */
export class ReceiverPreviewLayout {
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly preview: HTMLElement,
    private readonly cameraBox: HTMLElement,
  ) {}

  sync(): void {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (!width || !height) return
    this.cameraBox.style.aspectRatio = `${width} / ${height}`

    const viewportWidth = window.visualViewport?.width ?? window.innerWidth
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    if (viewportWidth > viewportHeight && viewportHeight <= 620) {
      const ratio = width / height
      const heightBudget = Math.max(1, viewportHeight - 108)
      const fittedWidth = Math.max(1, Math.min(this.preview.clientWidth || viewportWidth, 640, heightBudget * ratio))
      this.preview.style.width = `${fittedWidth}px`
      this.cameraBox.style.width = `${fittedWidth}px`
      this.cameraBox.style.height = `${fittedWidth / ratio}px`
      this.cameraBox.style.maxHeight = "none"
      return
    }

    this.clearSize()
  }

  reset(): void {
    this.clearSize()
    this.cameraBox.style.removeProperty("aspect-ratio")
  }

  private clearSize(): void {
    this.preview.style.removeProperty("width")
    this.cameraBox.style.removeProperty("width")
    this.cameraBox.style.removeProperty("height")
    this.cameraBox.style.removeProperty("max-height")
  }
}
