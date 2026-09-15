import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { useState } from "react"
import { countTextLines, LineNumbers } from "../components/LineNumbers.js"
import { Modal } from "../components/ui/Modal.js"
import { FileTree } from "../components/FileTree.js"
import { PanelSettingsPanel } from "../components/PasteSettingPanel.js"
import { defaultOpticalTransferSettings, type PasteSetting } from "../utils/pasteSetting.js"

import "@testing-library/jest-dom/vitest"

function ModalHarness({ firstOpen, secondOpen }: { firstOpen: boolean; secondOpen: boolean }) {
  return (
    <>
      <Modal isOpen={firstOpen} onClose={vi.fn()}>
        First
      </Modal>
      <Modal isOpen={secondOpen} onClose={vi.fn()}>
        Second
      </Modal>
    </>
  )
}

describe("Modal body scroll locking", () => {
  afterEach(() => {
    cleanup()
    document.body.style.overflow = ""
  })

  it("restores the previous overflow only after the last modal closes", () => {
    document.body.style.overflow = "clip"
    const view = render(<ModalHarness firstOpen secondOpen />)

    expect(document.body.style.overflow).toStrictEqual("hidden")
    view.rerender(<ModalHarness firstOpen={false} secondOpen />)
    expect(document.body.style.overflow).toStrictEqual("hidden")
    view.rerender(<ModalHarness firstOpen={false} secondOpen={false} />)
    expect(document.body.style.overflow).toStrictEqual("clip")
  })
})

describe("LineNumbers", () => {
  afterEach(cleanup)

  it("counts lines without allocating a regex match array", () => {
    expect(countTextLines("")).toStrictEqual(1)
    expect(countTextLines("one\ntwo\nthree")).toStrictEqual(3)
  })

  it("renders every line number in one text node", () => {
    render(<LineNumbers lineCount={3} data-testid="line-numbers" />)

    const lineNumbers = screen.getByTestId("line-numbers")
    expect(lineNumbers.textContent).toStrictEqual("1\n2\n3")
    expect(lineNumbers.children).toHaveLength(0)
  })
})

function uploadPasteSetting(): PasteSetting {
  return {
    uploadKind: "short",
    transferMethod: "upload",
    archiveCompression: "deflate",
    expiration: "1d",
    readLimit: "0",
    manageUrl: "",
    doEncrypt: false,
    verifyP2P: false,
    optical: { ...defaultOpticalTransferSettings() },
  }
}

function SettingPanelHarness({
  hasEditContent,
  files,
  transferMethod = "upload",
}: {
  hasEditContent: boolean
  files?: File[]
  transferMethod?: PasteSetting["transferMethod"]
}) {
  const [setting, setSetting] = useState(() => ({ ...uploadPasteSetting(), transferMethod }))
  return (
    <PanelSettingsPanel
      setting={setting}
      files={files}
      hasEditContent={hasEditContent}
      onSettingChange={setSetting}
      config={__WRANGLER_CONFIG__}
    />
  )
}

describe("PasteSettingPanel compress switch", () => {
  afterEach(cleanup)

  it("stays disabled when there is no content", () => {
    render(<SettingPanelHarness hasEditContent={false} />)

    const compress = screen.getByRole("checkbox", { name: "Compress as ZIP" })
    expect(compress).toBeDisabled()
  })

  it("stays disabled for multiple files", () => {
    const files = [new File(["one"], "one.txt"), new File(["two"], "two.txt")]
    render(<SettingPanelHarness hasEditContent={false} files={files} />)

    expect(screen.getByRole("checkbox", { name: "Compress as ZIP" })).toBeDisabled()
  })

  it("is enabled and toggles for non-empty edit content", async () => {
    render(<SettingPanelHarness hasEditContent />)

    const compress = screen.getByRole("checkbox", { name: "Compress as ZIP" })
    expect(compress).toBeEnabled()
    expect(compress).not.toBeChecked()

    await userEvent.click(compress)

    expect(compress).toBeChecked()
    expect(screen.getByLabelText("Compression status")).toHaveTextContent("on")
  })
})

describe("PasteSettingPanel URL kinds", () => {
  afterEach(cleanup)

  it("offers only short and long URLs", () => {
    render(<SettingPanelHarness hasEditContent />)

    expect(screen.getAllByRole("radio", { name: /^(Short|Long)$/ })).toHaveLength(2)
    expect(screen.queryByRole("radio", { name: "manage" })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText("Manage URL")).not.toBeInTheDocument()
  })

  it("reuses the short and long URL controls for P2P", () => {
    render(<SettingPanelHarness hasEditContent transferMethod="p2p" />)

    expect(screen.getAllByRole("radio", { name: /^(Short|Long)$/ })).toHaveLength(2)
  })

  it("selects the managed paste URL length without leaving manage mode", () => {
    render(
      <PanelSettingsPanel
        setting={{
          ...uploadPasteSetting(),
          uploadKind: "manage",
          manageUrl: "https://example.com/5HQWYNmjA4h44SmybeThXXAm:password",
        }}
        hasEditContent
        onSettingChange={vi.fn()}
        config={__WRANGLER_CONFIG__}
      />,
    )

    expect(screen.getByRole("radio", { name: "Long" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: "Short" })).toHaveAttribute("aria-checked", "false")
  })
})

describe("FileTree remove buttons", () => {
  afterEach(cleanup)

  it("calls onRemove for a file entry", async () => {
    const onRemove = vi.fn()
    render(
      <FileTree
        files={[
          { name: "a.txt", sizeBytes: 3 },
          { name: "b.txt", sizeBytes: 4 },
        ]}
        onRemove={onRemove}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "Remove a.txt" }))

    expect(onRemove).toHaveBeenCalledWith("a.txt", "file")
  })

  it("calls onRemove for a folder entry without toggling expansion", async () => {
    const onRemove = vi.fn()
    render(<FileTree files={[{ name: "folder/a.txt", sizeBytes: 3 }]} onRemove={onRemove} />)

    const remove = screen.getByRole("button", { name: "Remove folder" })
    expect(remove.parentElement?.closest("button")).toBeNull()
    await userEvent.click(remove)

    expect(onRemove).toHaveBeenCalledWith("folder/", "folder")
  })

  it("uses a stable id when duplicate names receive a display suffix", async () => {
    const onRemove = vi.fn()
    render(
      <FileTree
        files={[
          { id: "first", name: "a.txt", sizeBytes: 3 },
          { id: "second", name: "a.txt", sizeBytes: 4 },
        ]}
        onRemove={onRemove}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "Remove a (2).txt" }))

    expect(onRemove).toHaveBeenCalledWith("second", "file")
  })

  it("renders no remove buttons when onRemove is omitted", () => {
    render(<FileTree files={[{ name: "a.txt", sizeBytes: 3 }]} />)

    expect(screen.queryByRole("button", { name: "Remove a.txt" })).not.toBeInTheDocument()
  })
})
