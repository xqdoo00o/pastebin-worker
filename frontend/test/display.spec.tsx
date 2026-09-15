import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { DisplayPaste } from "../pages/DisplayPaste.js"

import "@testing-library/jest-dom/vitest"
import { userEvent } from "@testing-library/user-event"
import { setupServer } from "msw/node"
import { http, HttpResponse } from "msw"
import { encodeKey, encrypt, genKey } from "../utils/encryption.js"
import { stubBrowserFunctions, unStubBrowserFunctions } from "./testUtils.js"
import {
  BINARY_MIME_TYPE,
  DEFAULT_EDIT_FILENAME,
  MAX_AUTO_FETCH_BYTES,
  TEXT_MIME_TYPE,
} from "../../shared/constants.js"
import type { SerializedPasteData } from "../../shared/interfaces.js"
import { formatSize } from "../utils/utils.js"
import { LOCAL_UPLOADS_KEY } from "../utils/localUploads.js"
import * as responseDownload from "../utils/responseDownload.js"

interface RespInit {
  body: ArrayBuffer
  headers: Record<string, string>
}

function mockPaste(pasteName: string, init: RespInit) {
  const headers = { ...init.headers, "Content-Length": String(init.body.byteLength) }
  return [
    http.head(`/${pasteName}`, () => new HttpResponse(null, { headers })),
    http.get(`/m/${pasteName}`, () =>
      HttpResponse.json({
        lastModifiedAt: "",
        createdAt: "",
        expireAt: "",
        sizeBytes: init.body.byteLength,
        location: "KV",
      }),
    ),
    http.get(`/${pasteName}`, () => HttpResponse.arrayBuffer(init.body, { headers })),
  ]
}

function rememberLocalUpload(key = "abcd") {
  window.localStorage.setItem(
    LOCAL_UPLOADS_KEY,
    JSON.stringify([
      {
        key,
        displayUrl: `https://example.com/d/${key}`,
        manageUrl: `https://example.com/${key}:pw`,
        expireAt: "2099-01-01T00:00:00.000Z",
        sizeBytes: 1,
      },
    ]),
  )
}

const server = setupServer()

beforeAll(() => {
  stubBrowserFunctions()
  globalThis.URL.createObjectURL = () => "blob:mock"
  globalThis.URL.revokeObjectURL = () => undefined
  server.listen()
})

afterEach(() => {
  server.resetHandlers()
  cleanup()
  window.localStorage.clear()
  delete (window as Window & { __PASTE_DATA__?: SerializedPasteData }).__PASTE_DATA__
})

afterAll(() => {
  unStubBrowserFunctions()
  server.close()
})

describe("DisplayPaste", () => {
  it("aborts an in-flight initialization request when the page unmounts", async () => {
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))
    let requestSignal: AbortSignal | undefined
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted", "AbortError")),
          { once: true },
        )
      })
    })

    try {
      const view = render(<DisplayPaste config={__WRANGLER_CONFIG__} />)
      await waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal))
      view.unmount()
      expect(requestSignal?.aborted).toStrictEqual(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("defers cleanup of an OPFS-backed download when its page lifetime ends", async () => {
    const cleanupTemporaryFile = vi.fn(() => Promise.resolve())
    const deferTemporaryFileCleanup = vi.fn()
    const downloadFile = new File(["download"], "download.bin", { type: BINARY_MIME_TYPE })
    const downloadSpy = vi.spyOn(responseDownload, "downloadResponseToFile").mockResolvedValueOnce({
      file: downloadFile,
      cleanup: cleanupTemporaryFile,
      deferCleanup: deferTemporaryFileCleanup,
    })
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:disk-backed")
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL")
    const timeoutSpy = vi.spyOn(window, "setTimeout")
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    server.use(
      ...mockPaste("abcd", {
        body: new Uint8Array([1]).buffer,
        headers: { "Content-Type": BINARY_MIME_TYPE, "X-PB-Remaining-Reads": "1" },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    const view = render(<DisplayPaste config={__WRANGLER_CONFIG__} />)
    try {
      await userEvent.click(await screen.findByRole("button", { name: "Download file" }))
      await waitFor(() => expect(createObjectUrlSpy).toHaveBeenCalledWith(downloadFile))

      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 60_000)).toStrictEqual(false)
      expect(cleanupTemporaryFile).not.toHaveBeenCalled()
      expect(deferTemporaryFileCleanup).not.toHaveBeenCalled()
      expect(revokeObjectUrlSpy).not.toHaveBeenCalledWith("blob:disk-backed")

      view.unmount()
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:disk-backed")
      expect(cleanupTemporaryFile).not.toHaveBeenCalled()
      expect(deferTemporaryFileCleanup).toHaveBeenCalledOnce()
    } finally {
      view.unmount()
      downloadSpy.mockRestore()
      createObjectUrlSpy.mockRestore()
      revokeObjectUrlSpy.mockRestore()
      timeoutSpy.mockRestore()
      clickSpy.mockRestore()
    }
  })

  it("auto-fetches and highlights small plain text", async () => {
    const text = "hello world"
    server.use(
      ...mockPaste("abcd", {
        body: new TextEncoder().encode(text).buffer,
        headers: { "Content-Type": TEXT_MIME_TYPE },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const article = await screen.findByRole("article")
    expect(article.textContent).toStrictEqual(text)
  })

  it("previews an uploaded SVG even when the response is sanitized to text/plain", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="4" /></svg>'
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg-preview")
    server.use(
      ...mockPaste("abcd", {
        body: new TextEncoder().encode(svg).buffer,
        headers: {
          "Content-Type": TEXT_MIME_TYPE,
          "Content-Disposition": "inline; filename*=UTF-8''image.svg",
        },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    try {
      render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

      const preview = await screen.findByRole("img", { name: "image.svg" })
      await waitFor(() => expect(preview).toHaveAttribute("src", "blob:svg-preview"))
      const previewBlob = createObjectUrlSpy.mock.calls[createObjectUrlSpy.mock.calls.length - 1]?.[0]
      expect(previewBlob).toBeInstanceOf(Blob)
      expect((previewBlob as Blob).type).toStrictEqual("image/svg+xml")
    } finally {
      createObjectUrlSpy.mockRestore()
    }
  })

  it("renders received text with a verified header and bottom save/copy actions", async () => {
    const text = "const answer = 42"
    server.use(
      ...mockPaste("abcd", {
        body: new TextEncoder().encode(text).buffer,
        headers: {
          "Content-Type": TEXT_MIME_TYPE,
          "X-PB-Highlight-Language": "javascript",
        },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const article = await screen.findByRole("article")
    const language = screen.getByText("javascript")
    const copyButton = screen.getByRole("button", { name: "Copy" })
    const content = article.closest(".received-preview-content")
    const titleBar = content?.previousElementSibling
    const actions = content?.nextElementSibling
    expect(titleBar).toHaveTextContent("Verified")
    expect(titleBar).not.toContainElement(copyButton)
    expect(titleBar).toContainElement(language)
    expect(language.previousElementSibling).toHaveTextContent("·")
    const saveFile = screen.getByText("Save")
    expect(actions).toContainElement(saveFile)
    expect(saveFile.parentElement?.querySelector("svg")).not.toBeNull()
    expect(actions).toContainElement(copyButton)
  })

  it("does not infer syntax highlighting on the upload receiver", async () => {
    const text = "const answer = 42"
    server.use(
      ...mockPaste("abcd", {
        body: new TextEncoder().encode(text).buffer,
        headers: {
          "Content-Type": "text/javascript",
          "Content-Disposition": "inline; filename*=UTF-8''answer.js",
        },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    expect(await screen.findByRole("article")).toHaveTextContent(text)
    expect(screen.queryByText("javascript")).not.toBeInTheDocument()
  })

  it("renders plain image via raw URL without downloading bytes", async () => {
    // Body is irrelevant: the frontend should not GET it. We still provide a
    // GET handler that would fail loudly if it were called.
    let getCalled = false
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "12345",
            "Content-Disposition": "inline; filename*=UTF-8''cat.png",
          },
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return new HttpResponse(null, { status: 500 })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const img = await screen.findByRole("img")
    expect(img.getAttribute("src")).toStrictEqual("/abcd")
    expect(screen.getByText("Verified")).toBeInTheDocument()
    expect(screen.getByText("Save")).toHaveAttribute("href", "/abcd?a")
    expect(getCalled).toStrictEqual(false)
  })

  it("renders plain audio via raw URL without downloading bytes", async () => {
    let getCalled = false
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: { "Content-Type": "audio/mpeg", "Content-Length": "999999" },
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return new HttpResponse(null, { status: 500 })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const audio = await screen.findByLabelText("abcd")
    expect(audio.tagName.toLowerCase()).toStrictEqual("audio")
    expect(audio.getAttribute("src")).toStrictEqual("/abcd")
    expect(audio.hasAttribute("controls")).toStrictEqual(true)
    expect(getCalled).toStrictEqual(false)
  })

  it("renders plain video via raw URL without downloading bytes", async () => {
    let getCalled = false
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "9999999",
            "Content-Disposition": "inline; filename*=UTF-8''clip.mp4",
          },
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return new HttpResponse(null, { status: 500 })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const video = await screen.findByLabelText("clip.mp4")
    expect(video.tagName.toLowerCase()).toStrictEqual("video")
    expect(video.getAttribute("src")).toStrictEqual("/abcd")
    expect(video.hasAttribute("controls")).toStrictEqual(true)
    expect(getCalled).toStrictEqual(false)
  })

  it("auto-decrypts and renders small encrypted audio via blob URL", async () => {
    const scheme = "AES-GCM-CHUNKED"
    const key = await genKey(scheme)
    const fakeAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x44])
    const encryptedBytes = await encrypt(scheme, key, fakeAudio)
    server.use(
      ...mockPaste("abcd", {
        body: encryptedBytes.buffer as ArrayBuffer,
        headers: {
          "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
          "X-PB-Decrypted-Content-Type": "audio/mpeg",
          "Content-Type": BINARY_MIME_TYPE,
          "Content-Disposition": "inline; filename*=UTF-8''song.mp3.encrypted",
        },
      }),
    )
    vi.stubGlobal("location", new URL(`https://example.com/d/abcd#${await encodeKey(key)}`))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const audio = await screen.findByLabelText("song.mp3")
    expect(audio.tagName.toLowerCase()).toStrictEqual("audio")
    await waitFor(() => expect(audio.getAttribute("src")).toStrictEqual("blob:mock"))
  })

  it("auto-decrypts and renders a small encrypted image via blob URL", async () => {
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const scheme = "AES-GCM-CHUNKED"
    const key = await genKey(scheme)
    const encryptedBytes = await encrypt(scheme, key, pngHeader)
    server.use(
      ...mockPaste("abcd", {
        body: encryptedBytes.buffer as ArrayBuffer,
        headers: {
          "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
          "X-PB-Decrypted-Content-Type": "image/png",
          "Content-Type": BINARY_MIME_TYPE,
          "Content-Disposition": "inline; filename*=UTF-8''photo.png.encrypted",
        },
      }),
    )
    vi.stubGlobal("location", new URL(`https://example.com/d/abcd#${await encodeKey(key)}`))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const img = await screen.findByRole("img")
    await waitFor(() => expect(img.getAttribute("src")).toStrictEqual("blob:mock"))
    expect(img.getAttribute("alt")).toStrictEqual("photo.png")
  })

  it("auto-decrypts and renders a small encrypted text paste", async () => {
    const text = "encrypted hello"
    const scheme = "AES-GCM-CHUNKED"
    const key = await genKey(scheme)
    const encryptedBytes = await encrypt(scheme, key, new TextEncoder().encode(text))
    server.use(
      ...mockPaste("abcd", {
        body: encryptedBytes.buffer as ArrayBuffer,
        headers: {
          "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
          "X-PB-Decrypted-Content-Type": TEXT_MIME_TYPE,
          "Content-Type": BINARY_MIME_TYPE,
        },
      }),
      http.get("/m/abcd", () => {
        return HttpResponse.json({
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes: encryptedBytes.byteLength,
          location: "KV",
        })
      }),
    )
    vi.stubGlobal("location", new URL(`https://example.com/d/abcd#${await encodeKey(key)}`))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const article = await screen.findByRole("article")
    expect(article.textContent).toStrictEqual(text)
  })

  it("shows placeholder with load-anyway for oversized text", async () => {
    const oversized = new Uint8Array(MAX_AUTO_FETCH_BYTES + 1)
    let getCalled = false
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": TEXT_MIME_TYPE,
            "Content-Length": String(oversized.byteLength),
          },
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return HttpResponse.arrayBuffer(oversized.buffer)
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    expect(await screen.findByText("load anyway")).toBeInTheDocument()
    expect(screen.getByText("Download")).toBeInTheDocument()
    expect(getCalled).toStrictEqual(false)
  })

  it("does not auto-fetch read-limited text until load anyway is clicked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const text = "limited hello"
    let getCalled = false
    rememberLocalUpload()
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": TEXT_MIME_TYPE,
            "Content-Length": String(text.length),
            "X-PB-Remaining-Reads": "1",
          },
        })
      }),
      http.get("/m/abcd", () => {
        return HttpResponse.json({
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes: text.length,
          location: "KV",
          remainingReads: 1,
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return HttpResponse.arrayBuffer(new TextEncoder().encode(text).buffer, {
          headers: {
            "Content-Type": TEXT_MIME_TYPE,
            "Content-Length": String(text.length),
            "X-PB-Remaining-Reads": "1",
          },
        })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const loadAnyway = await screen.findByText("load anyway")
    expect(screen.getByText(/limited number of reads/)).toBeInTheDocument()
    expect(getCalled).toStrictEqual(false)

    await userEvent.click(loadAnyway)

    const article = await screen.findByRole("article")
    expect(article.textContent).toStrictEqual(text)
    expect(getCalled).toStrictEqual(true)
    expect(window.localStorage.getItem(LOCAL_UPLOADS_KEY)).toStrictEqual("[]")
    expect(screen.queryByText("The file has expired")).not.toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(screen.getByText("The file has expired")).toBeInTheDocument()
    expect(screen.getByText("The file has been permanently deleted.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Close expired notice" }))

    expect(screen.queryByText("The file has expired")).not.toBeInTheDocument()
  })

  it("removes local upload when downloading the final read from a read-limited shell", async () => {
    const text = "limited download"
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    rememberLocalUpload()
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": TEXT_MIME_TYPE,
            "Content-Length": String(text.length),
            "X-PB-Remaining-Reads": "1",
          },
        })
      }),
      http.get("/m/abcd", () => {
        return HttpResponse.json({
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes: text.length,
          location: "KV",
          remainingReads: 1,
        })
      }),
      http.get("/abcd", () => {
        return HttpResponse.arrayBuffer(new TextEncoder().encode(text).buffer, {
          headers: {
            "Content-Type": TEXT_MIME_TYPE,
            "Content-Length": String(text.length),
            "X-PB-Remaining-Reads": "1",
          },
        })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    await userEvent.click(await screen.findByText("Download"))

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled()
      expect(window.localStorage.getItem(LOCAL_UPLOADS_KEY)).toStrictEqual("[]")
    })
    clickSpy.mockRestore()
  })

  it("shows filename from Content-Disposition in the title even with a bare URL", async () => {
    const filename = "track.flac"
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": "audio/flac",
            "Content-Length": "27207192",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
          },
        })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const heading = await screen.findByRole("heading")
    expect(heading.textContent).toContain(filename)
  })

  it("hydrates from SSR-injected __PASTE_DATA__ and shows metadata filename in title", async () => {
    const text = "ssr-injected hello"
    const base64 = btoa(text)
    const injected: SerializedPasteData = {
      content: base64,
      name: "abcd",
      isBinary: false,
      guessedEncoding: "UTF-8",
      metadata: {
        lastModifiedAt: "",
        createdAt: "",
        expireAt: "",
        sizeBytes: text.length,
        location: "KV",
        filename: "ssr.txt",
      },
    }
    window.__PASTE_DATA__ = injected
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const article = await screen.findByRole("article")
    expect(article.textContent).toStrictEqual(text)
    const heading = await screen.findByRole("heading")
    expect(heading.textContent).toContain("ssr.txt")
    const previewTitle = article
      .closest(".received-preview-content")
      ?.previousElementSibling?.querySelector("strong[title]")
    expect(previewTitle).toHaveAttribute("title", "ssr.txt")
  })

  it("shows file sharing for an SSR-injected MP3 with its effective MIME type", async () => {
    const originalShare = Object.getOwnPropertyDescriptor(navigator, "share")
    const originalCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare")
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent")
    const canShare = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockResolvedValue(undefined) })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare })
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
    })

    try {
      const content = "ID3"
      window.__PASTE_DATA__ = {
        content: btoa(content),
        contentType: "audio/mpeg",
        name: "abcd",
        isBinary: true,
        guessedEncoding: null,
        metadata: {
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes: content.length,
          location: "KV",
          filename: "song.mp3",
        },
      }
      vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

      render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

      expect(await screen.findByTitle("Share file")).toBeInTheDocument()
      const fileShareData = canShare.mock.calls.map(([data]) => data as ShareData).find((data) => data.files?.length)
      expect(fileShareData?.files?.[0]).toMatchObject({ name: "song.mp3", type: "audio/mpeg" })
    } finally {
      if (originalShare) Object.defineProperty(navigator, "share", originalShare)
      else Reflect.deleteProperty(navigator, "share")
      if (originalCanShare) Object.defineProperty(navigator, "canShare", originalCanShare)
      else Reflect.deleteProperty(navigator, "canShare")
      if (originalUserAgent) Object.defineProperty(navigator, "userAgent", originalUserAgent)
      else Reflect.deleteProperty(navigator, "userAgent")
    }
  })

  it("removes local upload when SSR data consumes the final read", async () => {
    const text = "ssr final read"
    rememberLocalUpload()
    const injected: SerializedPasteData = {
      content: btoa(text),
      name: "abcd",
      isBinary: false,
      guessedEncoding: "UTF-8",
      metadata: {
        lastModifiedAt: "",
        createdAt: "",
        expireAt: "",
        sizeBytes: text.length,
        location: "KV",
        filename: "ssr.txt",
        remainingReads: 1,
      },
    }
    window.__PASTE_DATA__ = injected
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const article = await screen.findByRole("article")
    expect(article.textContent).toStrictEqual(text)
    expect(window.localStorage.getItem(LOCAL_UPLOADS_KEY)).toStrictEqual("[]")
  })

  it("hides the default Untitled filename from the heading but keeps it for content and download", async () => {
    const text = "untitled hello"
    const injected: SerializedPasteData = {
      content: btoa(text),
      name: "abcd",
      isBinary: false,
      guessedEncoding: "UTF-8",
      metadata: {
        lastModifiedAt: "",
        createdAt: "",
        expireAt: "",
        sizeBytes: text.length,
        location: "KV",
        filename: DEFAULT_EDIT_FILENAME,
      },
    }
    window.__PASTE_DATA__ = injected
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const article = await screen.findByRole("article")
    expect(article.textContent).toStrictEqual(text)

    const heading = await screen.findByRole("heading")
    expect(heading.textContent).not.toContain(DEFAULT_EDIT_FILENAME)
    expect(screen.getByText(DEFAULT_EDIT_FILENAME)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Save" }).getAttribute("download")).toStrictEqual(DEFAULT_EDIT_FILENAME)
  })

  it("shows SSR-injected zip content as a non-renderable archive", async () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
    const injected: SerializedPasteData = {
      content: btoa(String.fromCharCode(...zipBytes)),
      name: "abcd",
      isBinary: true,
      guessedEncoding: null,
      metadata: {
        lastModifiedAt: "",
        createdAt: "",
        expireAt: "",
        sizeBytes: zipBytes.byteLength,
        location: "KV",
        filename: "files.zip",
      },
    }
    window.__PASTE_DATA__ = injected
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    expect(await screen.findByText(/Not a renderable file \(application\/zip\)/)).toBeInTheDocument()
    expect(screen.getByText("Download")).toBeInTheDocument()
    await userEvent.click(screen.getByText("Click to show"))
    expect(await screen.findByRole("article")).toHaveTextContent("PK")
    expect(screen.queryByText(/not in UTF-8/)).not.toBeInTheDocument()
  })

  it("fetches and renders content when user clicks load anyway on oversized text", async () => {
    const originalShare = Object.getOwnPropertyDescriptor(navigator, "share")
    const originalCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare")
    const share = vi.fn((_data: ShareData) => Promise.resolve())
    Object.defineProperty(navigator, "share", { configurable: true, value: share })
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true })
    const oversized = new TextEncoder().encode("a".repeat(MAX_AUTO_FETCH_BYTES + 4))
    server.use(
      ...mockPaste("abcd", {
        body: oversized.buffer,
        headers: { "Content-Type": TEXT_MIME_TYPE },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    try {
      render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

      const loadAnyway = await screen.findByText("load anyway")
      await userEvent.click(loadAnyway)

      const article = await screen.findByRole("article")
      expect(article.textContent?.length).toBeGreaterThan(MAX_AUTO_FETCH_BYTES)

      await userEvent.click(await screen.findByTitle("Share file"))
      expect(share).toHaveBeenCalledOnce()
      expect(share.mock.calls[0][0].text).toBeUndefined()
      expect(share.mock.calls[0][0].files?.[0]).toMatchObject({ name: "abcd", size: oversized.byteLength })
    } finally {
      if (originalShare) Object.defineProperty(navigator, "share", originalShare)
      else Reflect.deleteProperty(navigator, "share")
      if (originalCanShare) Object.defineProperty(navigator, "canShare", originalCanShare)
      else Reflect.deleteProperty(navigator, "canShare")
    }
  })

  it("auto-decrypts and renders small encrypted video via blob URL", async () => {
    const scheme = "AES-GCM-CHUNKED"
    const key = await genKey(scheme)
    const fakeVideo = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
    const encryptedBytes = await encrypt(scheme, key, fakeVideo)
    server.use(
      ...mockPaste("abcd", {
        body: encryptedBytes.buffer as ArrayBuffer,
        headers: {
          "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
          "X-PB-Decrypted-Content-Type": "video/mp4",
          "Content-Type": BINARY_MIME_TYPE,
          "Content-Disposition": "inline; filename*=UTF-8''clip.mp4.encrypted",
        },
      }),
    )
    vi.stubGlobal("location", new URL(`https://example.com/d/abcd#${await encodeKey(key)}`))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const video = await screen.findByLabelText("clip.mp4")
    expect(video.tagName.toLowerCase()).toStrictEqual("video")
    await waitFor(() => expect(video.getAttribute("src")).toStrictEqual("blob:mock"))
  })

  it("falls back to placeholder when Content-Length is missing on text", async () => {
    let getCalled = false
    const sizeBytes = MAX_AUTO_FETCH_BYTES + 1
    server.use(
      http.head("/abcd", () => {
        // No Content-Length header at all (e.g. chunked response).
        return new HttpResponse(null, {
          headers: { "Content-Type": TEXT_MIME_TYPE },
        })
      }),
      http.get("/m/abcd", () => {
        return HttpResponse.json({
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes,
          location: "R2",
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return new HttpResponse(null, { status: 500 })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    expect(await screen.findByText("load anyway")).toBeInTheDocument()
    expect(screen.getByText(`abcd (${formatSize(sizeBytes)})`)).toBeInTheDocument()
    expect(getCalled).toStrictEqual(false)
  })

  it("shows placeholder for non-text non-image content", async () => {
    server.use(
      ...mockPaste("abcd", {
        body: new ArrayBuffer(8),
        headers: { "Content-Type": "application/pdf" },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    expect(await screen.findByText(/Not a renderable file/)).toBeInTheDocument()
    expect(screen.getByText("Download")).toBeInTheDocument()
    const downloadLink = screen.getByText("Download", { selector: "a.primary-button" })
    expect(downloadLink.getAttribute("href")).toStrictEqual("/abcd?a")
  })

  it("warns when an encrypted upload URL is missing its fragment key", async () => {
    server.use(
      ...mockPaste("abcd", {
        body: new ArrayBuffer(8),
        headers: {
          "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
          "X-PB-Decrypted-Content-Type": "application/zip",
          "Content-Type": BINARY_MIME_TYPE,
        },
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    expect(await screen.findByText("Decryption key is missing")).toBeInTheDocument()
    expect(
      screen.getByText(
        "This file is encrypted. Open the complete share URL, including # and the key after it, to decrypt the file.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByText("Download", { selector: "a.primary-button" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Dismiss missing decryption key notice" }))
    expect(screen.queryByText("Decryption key is missing")).not.toBeInTheDocument()
    expect(screen.getByText("Download", { selector: "a.primary-button" })).toBeInTheDocument()
  })

  it("downloads pending plain media through attachment URL without paste data", async () => {
    let getCalled = false
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "9999999",
            "Content-Disposition": "inline; filename*=UTF-8''clip.mp4",
          },
        })
      }),
      http.get("/abcd", () => {
        getCalled = true
        return new HttpResponse(null, { status: 500 })
      }),
    )
    vi.stubGlobal("location", new URL("https://example.com/d/abcd"))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    await screen.findByLabelText("clip.mp4")
    const downloadLink = screen.getByRole("link", { name: "Save" })
    expect(downloadLink.getAttribute("href")).toStrictEqual("/abcd?a")
    expect(downloadLink.getAttribute("download")).toStrictEqual("clip.mp4")
    expect(getCalled).toStrictEqual(false)
  })

  it("decrypts pending encrypted zip before download", async () => {
    const scheme = "AES-GCM-CHUNKED"
    const key = await genKey(scheme)
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
    const encryptedBytes = await encrypt(scheme, key, zipBytes)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock")
    server.use(
      ...mockPaste("abcd", {
        body: encryptedBytes.buffer as ArrayBuffer,
        headers: {
          "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
          "X-PB-Decrypted-Content-Type": "application/zip",
          "Content-Type": BINARY_MIME_TYPE,
          "Content-Disposition": "inline; filename*=UTF-8''files.zip.encrypted",
        },
      }),
      http.get("/m/abcd", () => {
        return HttpResponse.json({
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes: encryptedBytes.byteLength,
          location: "KV",
          filename: "files.zip",
        })
      }),
    )
    vi.stubGlobal("location", new URL(`https://example.com/d/abcd#${await encodeKey(key)}`))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    try {
      const downloadButton = await screen.findByRole("button", { name: "Download file" })
      await userEvent.click(downloadButton)

      await waitFor(() => {
        expect(createObjectUrlSpy).toHaveBeenCalled()
      })
      expect(screen.getByRole("button", { name: "Download file" })).toBeInTheDocument()
      expect(screen.getByText("Download")).toBeInTheDocument()
      expect(screen.queryByRole("link", { name: "Save" })).not.toBeInTheDocument()
    } finally {
      clickSpy.mockRestore()
      createObjectUrlSpy.mockRestore()
    }
  })

  it("uses metadata filename for decrypted pending downloads when raw response has no filename", async () => {
    const scheme = "AES-GCM-CHUNKED"
    const key = await genKey(scheme)
    const encryptedBytes = await encrypt(scheme, key, new TextEncoder().encode("secret text"))
    let downloadAnchor: HTMLAnchorElement | undefined
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
    server.use(
      http.head("/abcd", () => {
        return new HttpResponse(null, {
          headers: {
            "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
            "X-PB-Decrypted-Content-Type": TEXT_MIME_TYPE,
            "Content-Type": BINARY_MIME_TYPE,
            "Content-Length": String(MAX_AUTO_FETCH_BYTES + 1),
          },
        })
      }),
      http.get("/abcd", () => {
        return HttpResponse.arrayBuffer(encryptedBytes.buffer as ArrayBuffer, {
          headers: {
            "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
            "X-PB-Decrypted-Content-Type": TEXT_MIME_TYPE,
            "Content-Type": BINARY_MIME_TYPE,
            "Content-Length": String(encryptedBytes.byteLength),
          },
        })
      }),
      http.get("/m/abcd", () => {
        return HttpResponse.json({
          lastModifiedAt: "",
          createdAt: "",
          expireAt: "",
          sizeBytes: encryptedBytes.byteLength,
          location: "KV",
          filename: "original-name",
        })
      }),
    )
    vi.stubGlobal("location", new URL(`https://example.com/d/abcd#${await encodeKey(key)}`))

    render(<DisplayPaste config={__WRANGLER_CONFIG__} />)

    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
      downloadAnchor = node as HTMLAnchorElement
      return node
    })

    try {
      await userEvent.click(await screen.findByRole("button", { name: "Download file" }))

      await waitFor(() => {
        expect(downloadAnchor?.download).toStrictEqual("original-name")
      })
    } finally {
      clickSpy.mockRestore()
      appendSpy.mockRestore()
    }
  })
})
