import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMonochromeCanvasRenderer } from "../optical/send/monochrome-canvas-renderer.js"

function installContextFactory(canvas: HTMLCanvasElement, factory: (contextId: string) => unknown): void {
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: vi.fn(factory),
  })
}

function createWebGl2Mock(): { context: WebGL2RenderingContext; calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    activeTexture: vi.fn(),
    attachShader: vi.fn(),
    bindTexture: vi.fn(),
    bindVertexArray: vi.fn(),
    compileShader: vi.fn(),
    createProgram: vi.fn(() => ({ kind: "program" })),
    createShader: vi.fn(() => ({ kind: "shader" })),
    createTexture: vi.fn(() => ({ kind: "texture" })),
    createVertexArray: vi.fn(() => ({ kind: "vertex-array" })),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteTexture: vi.fn(),
    deleteVertexArray: vi.fn(),
    drawArrays: vi.fn(),
    getParameter: vi.fn(() => 4096),
    getProgramInfoLog: vi.fn(() => ""),
    getProgramParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    getShaderParameter: vi.fn(() => true),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    linkProgram: vi.fn(),
    pixelStorei: vi.fn(),
    shaderSource: vi.fn(),
    texImage2D: vi.fn(),
    texParameteri: vi.fn(),
    texSubImage2D: vi.fn(),
    uniform1i: vi.fn(),
    useProgram: vi.fn(),
    viewport: vi.fn(),
  }
  const context = {
    ...calls,
    CLAMP_TO_EDGE: 0x812f,
    COMPILE_STATUS: 0x8b81,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    MAX_TEXTURE_SIZE: 0x0d33,
    NEAREST: 0x2600,
    R8UI: 0x8232,
    RED_INTEGER: 0x8d94,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TRIANGLES: 0x0004,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNSIGNED_BYTE: 0x1401,
    VERTEX_SHADER: 0x8b31,
  } as unknown as WebGL2RenderingContext
  return { context, calls }
}

function createCanvas2dMock(): {
  context: CanvasRenderingContext2D
  calls: Record<string, ReturnType<typeof vi.fn>>
} {
  const calls = {
    createImageData: vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
      colorSpace: "srgb",
    })),
    fillRect: vi.fn(),
    putImageData: vi.fn(),
  }
  return { context: { ...calls, fillStyle: "" } as unknown as CanvasRenderingContext2D, calls }
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("monochrome canvas renderer", () => {
  it("uploads packed cells directly to a WebGL2 integer texture", () => {
    const canvas = document.createElement("canvas")
    const { context, calls } = createWebGl2Mock()
    installContextFactory(canvas, (contextId) => (contextId === "webgl2" ? context : null))

    const renderer = createMonochromeCanvasRenderer(
      canvas,
      { cellSize: 10, columns: 3, rows: 2 },
      document.createElement("canvas"),
    )

    expect(renderer.backend).toBe("webgl2")
    expect(canvas.width).toBe(30)
    expect(canvas.height).toBe(20)
    expect(canvas.style.imageRendering).toBe("pixelated")
    expect(calls.pixelStorei).toHaveBeenCalledWith(context.UNPACK_ALIGNMENT, 1)
    const allocation = calls.texImage2D.mock.calls[0]
    expect(allocation.slice(0, 9)).toEqual([
      context.TEXTURE_2D,
      0,
      context.R8UI,
      6,
      20,
      0,
      context.RED_INTEGER,
      context.UNSIGNED_BYTE,
      expect.any(Uint8Array),
    ])
    expect([...(allocation[8] as Uint8Array)]).toEqual(new Array(120).fill(0xff))
    expect(calls.shaderSource.mock.calls.some(([, source]) => String(source).includes("usampler2D"))).toBe(true)
    expect(calls.shaderSource.mock.calls.some(([, source]) => String(source).includes("u_height"))).toBe(true)
    const fragmentShader =
      calls.shaderSource.mock.calls
        .map(([, source]) => String(source))
        .find((source) => source.includes("usampler2D")) ?? ""
    expect(fragmentShader).toContain("ivec2(packed_x, y)")
    expect(fragmentShader).not.toContain("cell_row")

    const packed = new Uint8Array(20).fill(0xff)
    packed[0] = 0x7f
    calls.bindTexture.mockClear()
    calls.texSubImage2D.mockClear()
    calls.drawArrays.mockClear()
    renderer.updateCell(packed, 4)
    renderer.updateCell(packed, 1)
    renderer.render()

    expect(calls.bindTexture).toHaveBeenCalledOnce()
    expect(calls.texSubImage2D).toHaveBeenNthCalledWith(
      1,
      context.TEXTURE_2D,
      0,
      2,
      10,
      2,
      10,
      context.RED_INTEGER,
      context.UNSIGNED_BYTE,
      packed,
    )
    expect(calls.texSubImage2D).toHaveBeenNthCalledWith(
      2,
      context.TEXTURE_2D,
      0,
      2,
      0,
      2,
      10,
      context.RED_INTEGER,
      context.UNSIGNED_BYTE,
      packed,
    )
    expect(calls.drawArrays).toHaveBeenCalledOnce()

    renderer.updateCell(packed, 0)
    renderer.render()
    expect(calls.bindTexture).toHaveBeenCalledTimes(2)
    expect(calls.drawArrays).toHaveBeenCalledTimes(2)

    renderer.destroy()
    expect(calls.deleteTexture).toHaveBeenCalledOnce()
    expect(calls.deleteVertexArray).toHaveBeenCalledOnce()
    expect(calls.deleteProgram).toHaveBeenCalledOnce()
  })

  it("switches to Canvas 2D after WebGL context loss", () => {
    const canvas = document.createElement("canvas")
    const fallbackCanvas = document.createElement("canvas")
    const { context, calls } = createWebGl2Mock()
    const fallback = createCanvas2dMock()
    installContextFactory(canvas, (contextId) => (contextId === "webgl2" ? context : null))
    installContextFactory(fallbackCanvas, (contextId) => (contextId === "2d" ? fallback.context : null))
    const onFallback = vi.fn()
    const renderer = createMonochromeCanvasRenderer(
      canvas,
      {
        cellSize: 8,
        columns: 1,
        rows: 1,
        onFallback,
      },
      fallbackCanvas,
    )
    const packed = new Uint8Array(8).fill(0xff)

    const lost = new Event("webglcontextlost", { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(renderer.backend).toBe("2d")
    expect(renderer.canvas).toBe(fallbackCanvas)
    renderer.updateCell(packed, 0)
    expect(fallback.calls.putImageData).not.toHaveBeenCalled()
    renderer.render()
    expect(lost.defaultPrevented).toBe(true)
    expect(onFallback).toHaveBeenCalledOnce()
    expect(fallback.calls.putImageData).toHaveBeenCalledOnce()
    calls.texImage2D.mockClear()
    canvas.dispatchEvent(new Event("webglcontextrestored"))
    expect(calls.texImage2D).not.toHaveBeenCalled()
    renderer.destroy()
  })

  it("falls back when the QR grid exceeds the WebGL texture limit", () => {
    const canvas = document.createElement("canvas")
    const fallbackCanvas = document.createElement("canvas")
    const { context, calls } = createWebGl2Mock()
    calls.getParameter.mockReturnValue(4)
    const fallback = createCanvas2dMock()
    installContextFactory(canvas, (contextId) => (contextId === "webgl2" ? context : null))
    installContextFactory(fallbackCanvas, (contextId) => (contextId === "2d" ? fallback.context : null))

    const renderer = createMonochromeCanvasRenderer(canvas, { cellSize: 10, columns: 2, rows: 1 }, fallbackCanvas)

    expect(renderer.backend).toBe("2d")
    expect(renderer.canvas).toBe(fallbackCanvas)
    renderer.destroy()
  })

  it("places fallback cells in one reusable full-grid image", () => {
    const webGlCanvas = document.createElement("canvas")
    const canvas = document.createElement("canvas")
    let painted: ImageData | undefined
    const fallback = createCanvas2dMock()
    fallback.calls.putImageData.mockImplementation((image: ImageData) => {
      painted = image
    })
    installContextFactory(canvas, (contextId) => (contextId === "2d" ? fallback.context : null))

    installContextFactory(webGlCanvas, () => null)
    const renderer = createMonochromeCanvasRenderer(webGlCanvas, { cellSize: 10, columns: 2, rows: 1 }, canvas)
    const packed = new Uint8Array(20).fill(0xff)
    packed[0] = 0x7f
    renderer.updateCell(packed, 1)
    expect(fallback.calls.putImageData).not.toHaveBeenCalled()
    renderer.render()

    expect(renderer.backend).toBe("2d")
    expect(canvas.width).toBe(20)
    expect(canvas.height).toBe(10)
    expect(fallback.calls.createImageData).toHaveBeenCalledOnce()
    expect(fallback.calls.createImageData).toHaveBeenCalledWith(20, 10)
    expect(fallback.calls.fillRect).toHaveBeenCalledWith(0, 0, 20, 10)
    expect(fallback.calls.putImageData).toHaveBeenCalledWith(expect.any(Object), 0, 0, 10, 0, 10, 10)
    expect([...(painted?.data.slice(40, 48) ?? [])]).toEqual([0, 0, 0, 255, 255, 255, 255, 255])
    renderer.destroy()
  })

  it("batches fallback updates into one dirty rectangle per grid row", () => {
    const webGlCanvas = document.createElement("canvas")
    const canvas = document.createElement("canvas")
    const fallback = createCanvas2dMock()
    installContextFactory(webGlCanvas, () => null)
    installContextFactory(canvas, (contextId) => (contextId === "2d" ? fallback.context : null))
    const renderer = createMonochromeCanvasRenderer(webGlCanvas, { cellSize: 8, columns: 3, rows: 2 }, canvas)
    const packed = new Uint8Array(8).fill(0xff)

    renderer.updateCell(packed, 0)
    renderer.updateCell(packed, 2)
    renderer.updateCell(packed, 4)
    renderer.updateCell(packed, 5)
    expect(fallback.calls.putImageData).not.toHaveBeenCalled()
    renderer.render()

    expect(fallback.calls.putImageData).toHaveBeenCalledTimes(2)
    expect(fallback.calls.putImageData).toHaveBeenNthCalledWith(1, expect.any(Object), 0, 0, 0, 0, 24, 8)
    expect(fallback.calls.putImageData).toHaveBeenNthCalledWith(2, expect.any(Object), 0, 0, 8, 8, 16, 8)

    renderer.render()
    expect(fallback.calls.putImageData).toHaveBeenCalledTimes(2)
    renderer.updateCell(packed, 1)
    renderer.render()
    expect(fallback.calls.putImageData).toHaveBeenNthCalledWith(3, expect.any(Object), 0, 0, 8, 0, 8, 8)
    renderer.destroy()
  })
})
