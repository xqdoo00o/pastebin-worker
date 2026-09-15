import {
  createMonochromeRgbaLookup,
  expandMonochromeRgbaRegion,
  monochromeByteLength,
  monochromeStride,
} from "../shared/monochrome.js"

export interface MonochromeCanvasRenderer {
  readonly backend: "webgl2" | "2d"
  readonly canvas: HTMLCanvasElement
  updateCell(image: Uint8Array<ArrayBuffer>, index: number): void
  render(): void
  destroy(): void
}

export interface MonochromeCanvasRendererOptions {
  cellSize: number
  columns: number
  rows: number
  onFallback?: (cause: unknown) => void
  onError?: (cause: unknown) => void
}

const VERTEX_SHADER = `#version 300 es
void main() {
  const vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D u_packed;
uniform int u_cell_size;
uniform int u_stride;
uniform int u_height;

out vec4 output_color;

void main() {
  int x = int(gl_FragCoord.x);
  int y = u_height - 1 - int(gl_FragCoord.y);
  int cell_column = x / u_cell_size;
  int local_x = x - cell_column * u_cell_size;
  int packed_x = cell_column * u_stride + local_x / 8;
  uint packed = texelFetch(u_packed, ivec2(packed_x, y), 0).r;
  uint module = (packed >> uint(7 - (local_x & 7))) & 1u;
  float gray = float(module);
  output_color = vec4(gray, gray, gray, 1.0);
}`

function opaqueGrayPixel(gray: number): number {
  const rgba = Uint8ClampedArray.of(gray, gray, gray, 255)
  return new Uint32Array(rgba.buffer)[0]
}

const OPAQUE_WHITE = opaqueGrayPixel(255)
const MONOCHROME_RGBA_LOOKUP = createMonochromeRgbaLookup(opaqueGrayPixel(0), OPAQUE_WHITE)

function validateOptions({ cellSize, columns, rows }: MonochromeCanvasRendererOptions): void {
  if (![cellSize, columns, rows].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Monochrome canvas dimensions must be positive integers.")
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error("Could not allocate a WebGL shader.")
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const detail = gl.getShaderInfoLog(shader) || "unknown shader compiler error"
  gl.deleteShader(shader)
  throw new Error(`Could not compile the monochrome WebGL shader: ${detail}`)
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  let fragment: WebGLShader
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  } catch (cause) {
    gl.deleteShader(vertex)
    throw cause
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new Error("Could not allocate a WebGL program.")
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
  const detail = gl.getProgramInfoLog(program) || "unknown program linker error"
  gl.deleteProgram(program)
  throw new Error(`Could not link the monochrome WebGL program: ${detail}`)
}

class WebGlMonochromeCanvasRenderer implements MonochromeCanvasRenderer {
  readonly backend = "webgl2" as const
  private readonly stride: number
  private readonly packedWidth: number
  private readonly height: number
  private program: WebGLProgram | null = null
  private texture: WebGLTexture | null = null
  private vertexArray: WebGLVertexArrayObject | null = null
  // Playback submits every due cell before one render; bind the atlas once for
  // that update batch instead of once per cell.
  private updateBatchStarted = false
  private contextLost = false
  private destroyed = false

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly options: MonochromeCanvasRendererOptions,
    private readonly onFailure: (cause: unknown) => void,
  ) {
    this.stride = monochromeStride(options.cellSize)
    this.packedWidth = this.stride * options.columns
    this.height = options.cellSize * options.rows
    canvas.addEventListener("webglcontextlost", this.handleContextLost)
    try {
      this.initialize()
    } catch (cause) {
      canvas.removeEventListener("webglcontextlost", this.handleContextLost)
      this.releaseResources()
      throw cause
    }
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault()
    this.contextLost = true
    this.program = null
    this.texture = null
    this.vertexArray = null
    this.updateBatchStarted = false
    this.onFailure(new Error("The WebGL context was lost."))
  }

  private initialize(): void {
    const { gl, options } = this
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const textureWidth = this.packedWidth
    if (textureWidth > maxTextureSize || this.height > maxTextureSize) {
      throw new Error("The QR grid is larger than this device's WebGL texture limit.")
    }

    const program = createProgram(gl)
    const texture = gl.createTexture()
    const vertexArray = gl.createVertexArray()
    if (!texture || !vertexArray) {
      if (texture) gl.deleteTexture(texture)
      if (vertexArray) gl.deleteVertexArray(vertexArray)
      gl.deleteProgram(program)
      throw new Error("Could not allocate WebGL resources for the QR stream.")
    }

    this.program = program
    this.texture = texture
    this.vertexArray = vertexArray
    gl.useProgram(program)
    gl.bindVertexArray(vertexArray)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    const white = new Uint8Array(textureWidth * this.height)
    white.fill(0xff)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, textureWidth, this.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, white)

    const packedLocation = gl.getUniformLocation(program, "u_packed")
    const cellSizeLocation = gl.getUniformLocation(program, "u_cell_size")
    const strideLocation = gl.getUniformLocation(program, "u_stride")
    const heightLocation = gl.getUniformLocation(program, "u_height")
    if (!packedLocation || !cellSizeLocation || !strideLocation || !heightLocation) {
      this.releaseResources()
      throw new Error("Could not initialize the monochrome WebGL uniforms.")
    }
    gl.uniform1i(packedLocation, 0)
    gl.uniform1i(cellSizeLocation, options.cellSize)
    gl.uniform1i(strideLocation, this.stride)
    gl.uniform1i(heightLocation, this.height)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    this.render()
  }

  updateCell(image: Uint8Array<ArrayBuffer>, index: number): void {
    const planeBytes = monochromeByteLength(this.options.cellSize, this.options.cellSize)
    if (image.length !== planeBytes) {
      throw new Error("The monochrome QR cell dimensions do not match the canvas renderer.")
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.options.columns * this.options.rows) {
      throw new Error("The monochrome QR cell index is outside the canvas renderer.")
    }
    if (this.contextLost || this.destroyed) return
    const column = index % this.options.columns
    const row = Math.floor(index / this.options.columns)
    if (!this.updateBatchStarted) {
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture)
      this.updateBatchStarted = true
    }
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      column * this.stride,
      row * this.options.cellSize,
      this.stride,
      this.options.cellSize,
      this.gl.RED_INTEGER,
      this.gl.UNSIGNED_BYTE,
      image,
    )
  }

  render(): void {
    if (this.contextLost || this.destroyed) return
    this.gl.useProgram(this.program)
    this.gl.bindVertexArray(this.vertexArray)
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3)
    this.updateBatchStarted = false
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost)
    if (!this.contextLost) this.releaseResources()
  }

  private releaseResources(): void {
    if (this.texture) this.gl.deleteTexture(this.texture)
    if (this.vertexArray) this.gl.deleteVertexArray(this.vertexArray)
    if (this.program) this.gl.deleteProgram(this.program)
    this.texture = null
    this.vertexArray = null
    this.program = null
    this.updateBatchStarted = false
  }
}

class Canvas2dMonochromeRenderer implements MonochromeCanvasRenderer {
  readonly backend = "2d" as const
  private readonly scratch: ImageData
  private readonly pixels: Uint32Array
  private readonly dirtyMinColumns: Int32Array
  private readonly dirtyMaxColumns: Int32Array

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly options: MonochromeCanvasRendererOptions,
  ) {
    const { cellSize, columns, rows } = options
    this.scratch = context.createImageData(cellSize * columns, cellSize * rows)
    this.pixels = new Uint32Array(
      this.scratch.data.buffer,
      this.scratch.data.byteOffset,
      this.scratch.data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    )
    this.pixels.fill(OPAQUE_WHITE)
    this.dirtyMinColumns = new Int32Array(rows)
    this.dirtyMinColumns.fill(columns)
    this.dirtyMaxColumns = new Int32Array(rows)
    this.dirtyMaxColumns.fill(-1)
    context.fillStyle = "white"
    context.fillRect(0, 0, cellSize * columns, cellSize * rows)
  }

  updateCell(image: Uint8Array<ArrayBuffer>, index: number): void {
    const { cellSize, columns, rows } = this.options
    if (!Number.isInteger(index) || index < 0 || index >= columns * rows) {
      throw new Error("The monochrome QR cell index is outside the canvas renderer.")
    }
    const column = index % columns
    const row = Math.floor(index / columns)
    expandMonochromeRgbaRegion(
      image,
      cellSize,
      cellSize,
      this.pixels,
      this.scratch.width,
      column * cellSize,
      row * cellSize,
      MONOCHROME_RGBA_LOOKUP,
    )
    this.dirtyMinColumns[row] = Math.min(this.dirtyMinColumns[row], column)
    this.dirtyMaxColumns[row] = Math.max(this.dirtyMaxColumns[row], column)
  }

  render(): void {
    const { cellSize, columns, rows } = this.options
    for (let row = 0; row < rows; row++) {
      const firstColumn = this.dirtyMinColumns[row]
      const lastColumn = this.dirtyMaxColumns[row]
      if (lastColumn < firstColumn) continue
      this.context.putImageData(
        this.scratch,
        0,
        0,
        firstColumn * cellSize,
        row * cellSize,
        (lastColumn - firstColumn + 1) * cellSize,
        cellSize,
      )
      this.dirtyMinColumns[row] = columns
      this.dirtyMaxColumns[row] = -1
    }
  }

  destroy(): void {
    // The 2D context owns no explicit browser resources.
  }
}

function prepareCanvas(canvas: HTMLCanvasElement, options: MonochromeCanvasRendererOptions): void {
  canvas.width = options.cellSize * options.columns
  canvas.height = options.cellSize * options.rows
  canvas.style.imageRendering = "pixelated"
}

function createCanvas2dRenderer(
  canvas: HTMLCanvasElement,
  options: MonochromeCanvasRendererOptions,
): Canvas2dMonochromeRenderer {
  prepareCanvas(canvas, options)
  const context = canvas.getContext("2d", { alpha: false })
  if (!context) throw new Error("This browser cannot create a canvas renderer for the QR stream.")
  return new Canvas2dMonochromeRenderer(canvas, context, options)
}

class AdaptiveMonochromeCanvasRenderer implements MonochromeCanvasRenderer {
  private renderer: MonochromeCanvasRenderer
  private destroyed = false

  constructor(
    webGlCanvas: HTMLCanvasElement,
    private readonly fallbackCanvas: HTMLCanvasElement,
    private readonly options: MonochromeCanvasRendererOptions,
  ) {
    prepareCanvas(webGlCanvas, options)
    const gl = webGlCanvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    })
    if (gl) {
      try {
        this.renderer = new WebGlMonochromeCanvasRenderer(webGlCanvas, gl, options, this.fallbackToCanvas2d)
        console.info("[optical] QR renderer: WebGL2 (packed 1bpp texture)")
        return
      } catch (cause) {
        console.warn("[optical] WebGL2 QR renderer unavailable; using Canvas 2D.", cause)
      }
    }
    this.renderer = createCanvas2dRenderer(fallbackCanvas, options)
    console.info("[optical] QR renderer: Canvas 2D fallback")
  }

  get backend(): MonochromeCanvasRenderer["backend"] {
    return this.renderer.backend
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.canvas
  }

  updateCell(image: Uint8Array<ArrayBuffer>, index: number): void {
    this.renderer.updateCell(image, index)
  }

  render(): void {
    this.renderer.render()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.renderer.destroy()
  }

  private readonly fallbackToCanvas2d = (cause: unknown) => {
    if (this.destroyed || this.renderer.backend === "2d") return
    const previous = this.renderer
    try {
      this.renderer = createCanvas2dRenderer(this.fallbackCanvas, this.options)
      previous.destroy()
      console.warn("[optical] WebGL2 QR renderer failed; switched to Canvas 2D.", cause)
      this.options.onFallback?.(cause)
    } catch (fallbackCause) {
      this.options.onError?.(fallbackCause)
    }
  }
}

export function createMonochromeCanvasRenderer(
  canvas: HTMLCanvasElement,
  options: MonochromeCanvasRendererOptions,
  fallbackCanvas: HTMLCanvasElement,
): MonochromeCanvasRenderer {
  validateOptions(options)
  return new AdaptiveMonochromeCanvasRenderer(canvas, fallbackCanvas, options)
}
