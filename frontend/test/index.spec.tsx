import { describe, it, vi, expect, beforeAll, afterEach, afterAll } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { PasteBin } from "../pages/PasteBin.js"
import { MAX_TRANSFER_BYTES } from "../optical/shared/protocol.js"

export const mockedPasteUpload: PasteResponse = {
  url: "https://example.com/abcd",
  manageUrl: "https://example.com/abcd:aaaaaaaaaaaaaaaaaa",
  expireAt: "2025-05-01T00:00:00.000Z",
  expirationSeconds: 300,
  lastModifiedAt: "2025-04-30T23:55:00.000Z",
  createdAt: "2025-04-30T23:55:00.000Z",
  sizeBytes: 9,
  location: "KV",
}

export const mockedPasteContent = "something"
export const mockedPasteMeta = {
  lastModifiedAt: mockedPasteUpload.lastModifiedAt,
  createdAt: mockedPasteUpload.createdAt,
  expireAt: mockedPasteUpload.expireAt,
  sizeBytes: mockedPasteUpload.sizeBytes,
  location: mockedPasteUpload.location,
}

export const server = setupServer(
  http.post(`${__WRANGLER_CONFIG__.DEPLOY_URL}/`, () => {
    return HttpResponse.json(mockedPasteUpload)
  }),
  http.head(`${__WRANGLER_CONFIG__.DEPLOY_URL}/abcd`, () => {
    return new HttpResponse(null, {
      headers: {
        "Content-Type": TEXT_MIME_TYPE,
        "Content-Length": String(new TextEncoder().encode(mockedPasteContent).length),
      },
    })
  }),
  http.get(`${__WRANGLER_CONFIG__.DEPLOY_URL}/abcd`, () => {
    return HttpResponse.text(mockedPasteContent)
  }),
  http.get(`${__WRANGLER_CONFIG__.DEPLOY_URL}/m/abcd`, () => {
    return HttpResponse.json(mockedPasteMeta)
  }),
)

beforeAll(() => {
  stubBrowserFunctions()
  server.listen()
})

afterEach(() => {
  server.resetHandlers()
  window.localStorage.clear()
  cleanup()
})

afterAll(() => {
  unStubBrowserFunctions()
  server.close()
})

import "@testing-library/jest-dom/vitest"
import { userEvent } from "@testing-library/user-event"
import type { PasteResponse, PublicEnv } from "../../shared/interfaces.js"
import { BINARY_MIME_TYPE, TEXT_MIME_TYPE } from "../../shared/constants.js"
import { setupServer } from "msw/node"
import { http, HttpResponse } from "msw"
import { stubBrowserFunctions, unStubBrowserFunctions } from "./testUtils.js"
import { encodeKey, encrypt, genKey } from "../utils/encryption.js"
import { LOCAL_UPLOADS_KEY } from "../utils/localUploads.js"
import { OPTICAL_SENDER_SETTINGS_KEY } from "../optical/shared/settings.js"

const pasteConfig = {
  ...__WRANGLER_CONFIG__,
  DEFAULT_TRANSFER_METHOD: "upload",
  DEFAULT_TAB: "edit",
} satisfies PublicEnv

describe("Pastebin", () => {
  it("can upload", async () => {
    render(<PasteBin config={pasteConfig} />)

    const title = screen.getByText("Pastebin Worker")
    expect(title).toBeInTheDocument()

    const editor = screen.getByRole("textbox", { name: "Paste editor" })
    expect(editor).toBeInTheDocument()

    const submitter = screen.getByRole("button", { name: "Start" })
    expect(submitter).toBeInTheDocument()
    expect(submitter).not.toBeEnabled()

    await userEvent.type(editor, "something")

    expect(submitter).toBeEnabled()
    await userEvent.click(submitter)

    const urlShow = await screen.findByRole("textbox", { name: "Raw URL" })
    expect((urlShow as HTMLInputElement).value).toStrictEqual(mockedPasteUpload.url)

    const manageUrlShow = screen.getByRole("textbox", { name: "Manage URL" })
    expect((manageUrlShow as HTMLInputElement).value).toStrictEqual(mockedPasteUpload.manageUrl)
  })

  it.each([
    ["upload", "Start", "Error on Preparing Upload"],
    ["p2p", "Start P2P", "Error on Preparing P2P Share"],
    ["optical", "Start QR stream", "Error on Preparing QR Camera Share"],
  ] as const)(
    "shows an error dialog when a selected file becomes unreadable before %s starts",
    async (method, action, title) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const fileSlice = vi.spyOn(File.prototype, "slice").mockReturnValue({
        arrayBuffer: () => Promise.reject(new DOMException("The file could not be read", "NotReadableError")),
      } as Blob)
      try {
        render(<PasteBin config={{ ...pasteConfig, DEFAULT_TRANSFER_METHOD: method, DEFAULT_TAB: "file" }} />)
        const file = new File(["hello"], "deleted.txt", { type: "text/plain" })

        fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
          target: { files: [file] },
        })
        const start = screen.getByRole("button", { name: action })
        await waitFor(() => expect(start).toBeEnabled())
        await userEvent.click(start)

        expect(await screen.findByRole("dialog")).toBeInTheDocument()
        expect(screen.getByText(title)).toBeInTheDocument()
      } finally {
        fileSlice.mockRestore()
        consoleError.mockRestore()
      }
    },
  )

  it("keeps a completed upload when transfer modes are only previewed", async () => {
    render(<PasteBin config={pasteConfig} />)

    await userEvent.type(screen.getByRole("textbox", { name: "Paste editor" }), "something")
    await userEvent.click(screen.getByRole("button", { name: "Start" }))
    await screen.findByRole("textbox", { name: "Raw URL" })
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("radio", { name: "P2P" }))
    expect(screen.getByRole("button", { name: "Start P2P" })).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Raw URL" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("radio", { name: "Upload" }))
    expect(screen.getByRole("textbox", { name: "Raw URL" })).toHaveValue(mockedPasteUpload.url)
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()
  })

  it("enables a normal update only after the uploaded content or settings change", async () => {
    server.use(
      http.post(`${pasteConfig.DEPLOY_URL}/`, () =>
        HttpResponse.json({
          ...mockedPasteUpload,
          url: `${pasteConfig.DEPLOY_URL}/abcd`,
          manageUrl: `${pasteConfig.DEPLOY_URL}/abcd:aaaaaaaaaaaaaaaaaa`,
        }),
      ),
      http.put(`${pasteConfig.DEPLOY_URL}/abcd:aaaaaaaaaaaaaaaaaa`, () =>
        HttpResponse.json({
          ...mockedPasteUpload,
          url: `${pasteConfig.DEPLOY_URL}/abcd`,
          manageUrl: `${pasteConfig.DEPLOY_URL}/abcd:aaaaaaaaaaaaaaaaaa`,
        }),
      ),
    )
    render(<PasteBin config={pasteConfig} />)
    const editor = screen.getByRole("textbox", { name: "Paste editor" })
    await userEvent.type(editor, "something")
    await userEvent.click(screen.getByRole("button", { name: "Start" }))

    const update = await screen.findByRole("button", { name: "Update" })
    expect(update).toBeDisabled()

    await userEvent.type(editor, " changed")
    expect(screen.getByRole("textbox", { name: "Paste editor" })).toHaveValue("something changed")
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeEnabled())
    await userEvent.click(update)
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeDisabled())

    const expiration = screen
      .getAllByRole("textbox", { name: "Expiration" })
      .find((element) => !element.hasAttribute("readonly"))!
    await userEvent.clear(expiration)
    await userEvent.type(expiration, "2h")
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled()
  })

  it("starts a new upload with POST using the link type shown in the managed upload UI", async () => {
    let postCount = 0
    let putCount = 0
    const privateUploads: boolean[] = []
    const firstKey = "5HQWYNmjA4h44SmybeThXXAm"
    const secondKey = "7HQWYNmjA4h44SmybeThXXAm"
    server.use(
      http.post(`${pasteConfig.DEPLOY_URL}/`, async ({ request }) => {
        postCount += 1
        privateUploads.push((await request.text()).includes('name="p"'))
        const key = postCount === 1 ? firstKey : secondKey
        return HttpResponse.json({
          ...mockedPasteUpload,
          url: `${pasteConfig.DEPLOY_URL}/${key}`,
          manageUrl: `${pasteConfig.DEPLOY_URL}/${key}:aaaaaaaaaaaaaaaaaa`,
        })
      }),
      http.put(`${pasteConfig.DEPLOY_URL}/*`, () => {
        putCount += 1
        return HttpResponse.json(mockedPasteUpload)
      }),
    )
    render(<PasteBin config={pasteConfig} />)

    await userEvent.type(screen.getByRole("textbox", { name: "Paste editor" }), "something")
    await userEvent.click(screen.getByRole("button", { name: "Start" }))

    const update = await screen.findByRole("button", { name: "Update" })
    const newUpload = screen.getByRole("button", { name: "New" })
    const deleteUpload = screen.getByRole("button", { name: "Delete" })
    expect(update).toBeDisabled()
    await waitFor(() => expect(newUpload).toBeEnabled())
    expect(screen.getByRole("radio", { name: "Long" })).toHaveAttribute("aria-checked", "true")
    expect(update.nextElementSibling).toBe(newUpload)
    expect(newUpload.nextElementSibling).toBe(deleteUpload)

    await userEvent.click(newUpload)

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Raw URL" })).toHaveValue(`${pasteConfig.DEPLOY_URL}/${secondKey}`),
    )
    expect(postCount).toBe(2)
    expect(putCount).toBe(0)
    expect(privateUploads).toEqual([false, true])
  })

  it("shows remaining reads in the local uploads sidebar", async () => {
    server.use(
      http.post(`${__WRANGLER_CONFIG__.DEPLOY_URL}/`, () => {
        return HttpResponse.json({
          ...mockedPasteUpload,
          expireAt: "2099-05-01T00:00:00.000Z",
          remainingReads: 1,
        })
      }),
    )
    render(<PasteBin config={pasteConfig} />)

    await userEvent.type(screen.getByRole("textbox", { name: "Paste editor" }), "something")
    await userEvent.click(screen.getByRole("button", { name: "Start" }))

    const availability = await screen.findByText(/or 1 read/)
    expect(availability).toBeInTheDocument()
  })

  it("refuse illegal settings", async () => {
    render(<PasteBin config={pasteConfig} />)
    // due to bugs https://github.com/adobe/react-spectrum/discussions/8037, we need to use duplicated name here
    const expire = screen.getByRole("textbox", { name: "Expiration" })
    expect(expire).toBeValid()
    await userEvent.type(expire, "xxx")
    expect(expire).toBeInvalid()
  })

  it("uses DEFAULT_READS as the initial reads setting", () => {
    render(<PasteBin config={{ ...pasteConfig, DEFAULT_READS: 2 }} />)

    const reads = screen.getByRole("spinbutton", { name: "Reads" })
    expect(reads).toBeValid()
    expect(reads).toHaveValue(2)
  })

  it.each([
    ["edit", "Paste editor"],
    ["file", "Select file"],
  ] as const)("uses DEFAULT_TAB=%s as the initial input tab", (defaultTab, panelName) => {
    render(<PasteBin config={{ ...pasteConfig, DEFAULT_TAB: defaultTab }} />)

    const panel = screen.getByRole(defaultTab === "edit" ? "textbox" : "button", { name: panelName })
    expect(panel).toBeInTheDocument()
  })

  it("adds files from the add-files picker without replacing the current selection", async () => {
    const { container } = render(<PasteBin config={{ ...pasteConfig, DEFAULT_TAB: "file" }} />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const first = new File(["first"], "first.txt", { type: "text/plain" })
    const second = new File(["second"], "second.txt", { type: "text/plain" })
    const third = new File(["third"], "third.txt", { type: "text/plain" })

    await userEvent.upload(input, first)
    expect(screen.getByText("first.txt")).toBeInTheDocument()
    expect(screen.getByText(/Click or drag or paste to replace/).closest(".text-foreground")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Add files" }))
    await userEvent.upload(input, second)

    expect(screen.getByText("2 items selected")).toBeInTheDocument()
    expect(screen.getByText("first.txt").closest(".text-foreground")).toBeInTheDocument()
    expect(screen.getByText("second.txt")).toBeInTheDocument()

    fireEvent.drop(screen.getByRole("button", { name: "Add files" }), {
      dataTransfer: { items: [], files: [third] },
    })
    await waitFor(() => expect(screen.getByText("3 items selected")).toBeInTheDocument())
    expect(screen.getByText("third.txt")).toBeInTheDocument()
  })

  it("disambiguates duplicate file names in the preview", async () => {
    const { container } = render(<PasteBin config={{ ...pasteConfig, DEFAULT_TAB: "file" }} />)
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const first = new File(["first"], "duplicate.txt", { type: "text/plain" })
    const second = new File(["second"], "duplicate.txt", { type: "text/plain" })

    await userEvent.upload(input, first)
    await userEvent.click(screen.getByRole("button", { name: "Add files" }))
    await userEvent.upload(input, second)

    expect(screen.getByText("duplicate.txt")).toBeInTheDocument()
    expect(screen.getByText("duplicate (2).txt")).toBeInTheDocument()
  })

  it("uses DEFAULT_TRANSFER_METHOD as the initial method", () => {
    render(<PasteBin config={{ ...__WRANGLER_CONFIG__, DEFAULT_TRANSFER_METHOD: "p2p" }} />)

    expect(screen.getByRole("radio", { name: "P2P" })).toBeChecked()
    expect(screen.getByRole("button", { name: "Start P2P" })).toBeInTheDocument()
  })

  it("uses DEFAULT_LINK_TYPE as the initial Upload/P2P link type", async () => {
    render(<PasteBin config={{ ...pasteConfig, DEFAULT_LINK_TYPE: "long" }} />)

    expect(screen.getByRole("radio", { name: "Long" })).toHaveAttribute("aria-checked", "true")
    await userEvent.click(screen.getByRole("radio", { name: "P2P" }))
    expect(screen.getByRole("radio", { name: "Long" })).toHaveAttribute("aria-checked", "true")
  })

  it("uses DEFAULT_E2E_ENCRYPTION only as the initial Upload encryption setting", async () => {
    const initialUpload = render(<PasteBin config={{ ...pasteConfig, DEFAULT_E2E_ENCRYPTION: true }} />)

    expect(screen.getByRole("checkbox", { name: "End-to-end encryption" })).toBeChecked()
    initialUpload.unmount()

    render(<PasteBin config={{ ...pasteConfig, DEFAULT_TRANSFER_METHOD: "p2p", DEFAULT_E2E_ENCRYPTION: true }} />)
    expect(screen.getByRole("checkbox", { name: "Verify data integrity" })).toBeChecked()

    await userEvent.click(screen.getByRole("radio", { name: "Upload" }))
    expect(screen.getByRole("checkbox", { name: "End-to-end encryption" })).toBeChecked()
  })

  it("offers paste, P2P, and QR as independent transfer methods", async () => {
    render(<PasteBin config={{ ...__WRANGLER_CONFIG__, DEFAULT_TRANSFER_METHOD: "p2p" }} />)

    expect(screen.getByRole("radiogroup", { name: "Transfer method" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Upload" })).not.toBeChecked()
    expect(screen.getByRole("radio", { name: "P2P" })).toBeChecked()
    const opticalMethod = screen.getByRole("radio", { name: "QR" })
    expect(opticalMethod).not.toBeChecked()
    await userEvent.click(opticalMethod)

    expect(opticalMethod).toBeChecked()
    expect(screen.getByRole("button", { name: "Start QR stream" })).toBeInTheDocument()
    const txFps = screen.getByRole("combobox", { name: "Optical TX FPS" })
    expect(txFps).toHaveValue(String(__WRANGLER_CONFIG__.DEFAULT_QR_TX_FPS))
    expect(Array.from(txFps.querySelectorAll("option"), (option) => option.value)).toEqual([
      "10",
      "15",
      "20",
      "24",
      "30",
      "50",
      "60",
      "90",
      "120",
    ])
    expect(screen.getByRole("combobox", { name: "Optical bytes per frame" })).toHaveValue(
      String(__WRANGLER_CONFIG__.DEFAULT_QR_FRAME_BYTES),
    )
    expect(screen.getByRole("combobox", { name: "Optical error correction" })).toHaveValue(
      __WRANGLER_CONFIG__.DEFAULT_QR_ECC,
    )
    const layout = screen.getByRole("combobox", { name: "Optical QR layout" })
    expect(layout).toHaveValue(String(__WRANGLER_CONFIG__.DEFAULT_QR_LAYOUT))
    expect(Array.from(layout.querySelectorAll("option"), (option) => option.textContent)).toEqual([
      "1 code",
      "2 codes (1×2)",
      "4 codes (2×2)",
      "6 codes (2×3)",
      "9 codes (3×3)",
    ])
    expect(screen.queryByText(/Receiver:/)).not.toBeInTheDocument()
    expect(screen.queryByRole("slider")).not.toBeInTheDocument()
    expect(screen.queryByRole("spinbutton", { name: "Transfers" })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "Verify data integrity" })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "P2P transfer" })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: "QR transfer" })).not.toBeInTheDocument()

    const frameBytes = screen.getByRole("combobox", { name: "Optical bytes per frame" })
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Optical error correction" }), "H")
    expect(frameBytes).toHaveValue("1000")
    expect(Array.from(frameBytes.querySelectorAll("option"), (option) => option.value)).toEqual(["500", "1000"])
  })

  it("locks QR archive controls and restores the upload algorithm when leaving QR", async () => {
    render(<PasteBin config={{ ...pasteConfig, DEFAULT_ARCHIVE_COMPRESSION: "deflate" }} />)

    const compression = screen.getByRole("radiogroup", { name: "Archive compression" })
    const deflate = within(compression).getByRole("radio", { name: "Deflate" })
    const zstd = within(compression).getByRole("radio", { name: "Zstd" })
    await userEvent.click(zstd)
    expect(zstd).toHaveAttribute("aria-checked", "true")

    await userEvent.click(screen.getByRole("radio", { name: "QR" }))
    expect(screen.getByRole("checkbox", { name: "Compress as ZIP" })).toBeDisabled()
    expect(zstd).toHaveAttribute("aria-checked", "true")
    expect(deflate).toBeDisabled()
    expect(zstd).toBeDisabled()

    await userEvent.click(screen.getByRole("radio", { name: "Upload" }))
    expect(zstd).toHaveAttribute("aria-checked", "true")
    expect(deflate).toHaveAttribute("aria-checked", "false")
    expect(deflate).toBeEnabled()
  })

  it("uses the QR camera defaults configured by Wrangler", async () => {
    render(
      <PasteBin
        config={{
          ...pasteConfig,
          DEFAULT_QR_TX_FPS: 24,
          DEFAULT_QR_FRAME_BYTES: 1465,
          DEFAULT_QR_ECC: "Q",
          DEFAULT_QR_LAYOUT: 4,
        }}
      />,
    )
    await userEvent.click(screen.getByRole("radio", { name: "QR" }))

    expect(screen.getByRole("combobox", { name: "Optical TX FPS" })).toHaveValue("24")
    expect(screen.getByRole("combobox", { name: "Optical bytes per frame" })).toHaveValue("1465")
    expect(screen.getByRole("combobox", { name: "Optical error correction" })).toHaveValue("Q")
    expect(screen.getByRole("combobox", { name: "Optical QR layout" })).toHaveValue("4")
  })

  it("restores and updates saved QR sender settings ahead of Wrangler defaults", async () => {
    localStorage.setItem(
      OPTICAL_SENDER_SETTINGS_KEY,
      JSON.stringify({ version: 1, txFps: 24, frameBytes: 1465, ecc: "Q", gridCodes: 2 }),
    )
    render(
      <PasteBin
        config={{
          ...pasteConfig,
          DEFAULT_QR_TX_FPS: 60,
          DEFAULT_QR_FRAME_BYTES: 2953,
          DEFAULT_QR_ECC: "L",
          DEFAULT_QR_LAYOUT: 4,
        }}
      />,
    )
    await userEvent.click(screen.getByRole("radio", { name: "QR" }))

    const fps = screen.getByRole("combobox", { name: "Optical TX FPS" })
    expect(fps).toHaveValue("24")
    expect(screen.getByRole("combobox", { name: "Optical bytes per frame" })).toHaveValue("1465")
    expect(screen.getByRole("combobox", { name: "Optical error correction" })).toHaveValue("Q")
    expect(screen.getByRole("combobox", { name: "Optical QR layout" })).toHaveValue("2")

    await userEvent.selectOptions(fps, "90")
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(OPTICAL_SENDER_SETTINGS_KEY)!)).toMatchObject({ txFps: 90 })
    })
  })

  it("allows files beyond the per-part limit through the multi-part QR stream", async () => {
    render(<PasteBin config={pasteConfig} />)
    await userEvent.click(screen.getByRole("radio", { name: "QR" }))
    await userEvent.click(screen.getByRole("tab", { name: "File" }))

    const file = new File(["x"], "large.bin", { type: "application/octet-stream" })
    Object.defineProperty(file, "size", { value: 65 * 1024 * 1024 })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    await userEvent.upload(input, file)
    await userEvent.click(screen.getByRole("button", { name: "Start QR stream" }))

    // 65 MB is beyond the 64 MB per-part limit but now fits a split transfer.
    expect(screen.queryByText("Paste too large")).not.toBeInTheDocument()
  })

  it("shows the standard size modal beyond the multi-part transfer limit", async () => {
    render(<PasteBin config={pasteConfig} />)
    await userEvent.click(screen.getByRole("radio", { name: "QR" }))
    await userEvent.click(screen.getByRole("tab", { name: "File" }))

    const file = new File(["x"], "oversized.bin", { type: "application/octet-stream" })
    Object.defineProperty(file, "size", { value: MAX_TRANSFER_BYTES + 1024 * 1024 * 1024 })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    await userEvent.upload(input, file)
    await userEvent.click(screen.getByRole("button", { name: "Start QR stream" }))

    await waitFor(() => {
      expect(screen.getByText("Paste too large")).toBeInTheDocument()
      expect(screen.getByText("File too large (2.00 GB > 1.00 GB)")).toBeInTheDocument()
    })
    expect(screen.queryByText(/Files are limited/)).not.toBeInTheDocument()
  })

  it("clears current manage state when another tab removes the local upload", async () => {
    render(<PasteBin config={pasteConfig} />)

    const editor = screen.getByRole("textbox", { name: "Paste editor" })
    await userEvent.type(editor, "something")
    await userEvent.click(screen.getByRole("button", { name: "Start" }))

    await screen.findByRole("textbox", { name: "Raw URL" })
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument()

    window.localStorage.setItem(LOCAL_UPLOADS_KEY, "[]")
    window.dispatchEvent(new StorageEvent("storage", { key: LOCAL_UPLOADS_KEY, newValue: "[]" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument()
      expect(screen.queryByRole("textbox", { name: "Manage URL" })).not.toBeInTheDocument()
    })
  })
})

describe("Pastebin admin page", () => {
  it("renders admin page", async () => {
    vi.stubGlobal("location", new URL("https://example.com/abcd:xxxxxxxxx"))
    render(
      <PasteBin
        config={{
          ...__WRANGLER_CONFIG__,
          DEFAULT_TRANSFER_METHOD: "p2p",
          DEFAULT_E2E_ENCRYPTION: true,
          DEFAULT_TAB: "edit",
        }}
      />,
    )

    const editor = screen.getByRole("textbox", { name: "Paste editor" })
    expect(editor).toBeInTheDocument()
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toStrictEqual(mockedPasteContent))
    expect(screen.getByRole("radio", { name: "Upload" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "End-to-end encryption" })).not.toBeChecked()
    expect(screen.getByText("Uploaded Paste")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Manage URL" })).toHaveValue(
      `${__WRANGLER_CONFIG__.DEPLOY_URL}/abcd:xxxxxxxxx`,
    )
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled()
    await userEvent.type(editor, " changed")
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled()
  })

  it("decrypts encrypted admin text when the URL hash has the key", async () => {
    const key = await genKey("AES-GCM-CHUNKED")
    const encodedKey = await encodeKey(key)
    const ciphertext = await encrypt("AES-GCM-CHUNKED", key, new TextEncoder().encode(mockedPasteContent))
    vi.stubGlobal("location", new URL(`https://example.com/abcd:xxxxxxxxx#${encodedKey}`))
    server.use(
      http.get(`${__WRANGLER_CONFIG__.DEPLOY_URL}/m/abcd`, () => {
        return HttpResponse.json({
          ...mockedPasteMeta,
          sizeBytes: ciphertext.length,
          highlightLanguage: "plaintext",
          encryptionScheme: "AES-GCM-CHUNKED",
        })
      }),
      http.head(`${__WRANGLER_CONFIG__.DEPLOY_URL}/abcd`, () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": BINARY_MIME_TYPE,
            "Content-Length": String(ciphertext.length),
            "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
            "X-PB-Decrypted-Content-Type": TEXT_MIME_TYPE,
            "X-PB-Highlight-Language": "plaintext",
          },
        })
      }),
      http.get(`${__WRANGLER_CONFIG__.DEPLOY_URL}/abcd`, () => {
        return new HttpResponse(ciphertext, {
          headers: {
            "Content-Type": BINARY_MIME_TYPE,
            "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
            "X-PB-Decrypted-Content-Type": TEXT_MIME_TYPE,
          },
        })
      }),
    )

    render(<PasteBin config={pasteConfig} />)

    const editor = screen.getByRole("textbox", { name: "Paste editor" })
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toStrictEqual(mockedPasteContent))
    expect(screen.getByRole("checkbox", { name: "End-to-end encryption" })).toBeChecked()
  })

  it("does not render encrypted admin text without the URL hash key", async () => {
    const key = await genKey("AES-GCM-CHUNKED")
    const ciphertext = await encrypt("AES-GCM-CHUNKED", key, new TextEncoder().encode(mockedPasteContent))
    vi.stubGlobal("location", new URL("https://example.com/abcd:xxxxxxxxx"))
    server.use(
      http.get(`${__WRANGLER_CONFIG__.DEPLOY_URL}/m/abcd`, () => {
        return HttpResponse.json({
          ...mockedPasteMeta,
          sizeBytes: ciphertext.length,
          highlightLanguage: "plaintext",
          encryptionScheme: "AES-GCM-CHUNKED",
        })
      }),
      http.head(`${__WRANGLER_CONFIG__.DEPLOY_URL}/abcd`, () => {
        return new HttpResponse(null, {
          headers: {
            "Content-Type": BINARY_MIME_TYPE,
            "Content-Length": String(ciphertext.length),
            "X-PB-Encryption-Scheme": "AES-GCM-CHUNKED",
            "X-PB-Decrypted-Content-Type": TEXT_MIME_TYPE,
            "X-PB-Highlight-Language": "plaintext",
          },
        })
      }),
    )

    render(<PasteBin config={pasteConfig} />)

    const editor = screen.getByRole("textbox", { name: "Paste editor" })
    await screen.findByText("Decryption key required")
    expect((editor as HTMLTextAreaElement).value).toStrictEqual("")
    expect(screen.getByRole("checkbox", { name: "End-to-end encryption" })).toBeChecked()
  })
})
