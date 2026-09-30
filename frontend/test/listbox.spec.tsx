import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Select, SelectItem } from "../components/ui/Select.js"
import { Autocomplete, AutocompleteItem } from "../components/ui/Autocomplete.js"
import "@testing-library/jest-dom/vitest"

const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")
beforeEach(() => {
  vi.stubGlobal("CSS", { escape: (value: string) => value })
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
})

describe("listbox keyboard interaction", () => {
  it("moves from the selected option, commits once, and dismisses on Escape or blur", () => {
    const onSelectionChange = vi.fn()
    render(
      <Select selectedKeys={["a"]} onSelectionChange={onSelectionChange}>
        <SelectItem value="a">Alpha</SelectItem>
        <SelectItem value="b">Beta</SelectItem>
      </Select>,
    )
    const trigger = screen.getByRole("button", { name: "Alpha" })
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    fireEvent.keyDown(trigger, { key: "ArrowDown" })
    fireEvent.keyDown(trigger, { key: "Enter" })
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(new Set(["b"]))
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.keyDown(trigger, { key: "Escape" })
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument()
    fireEvent.keyDown(trigger, { key: "Enter" })
    fireEvent.blur(trigger, { relatedTarget: document.body })
    expect(screen.queryByRole("button", { name: "Beta" })).not.toBeInTheDocument()
  })

  it("ignores selection keys when a Select has no options", () => {
    const onSelectionChange = vi.fn()
    render(<Select onSelectionChange={onSelectionChange}>{null}</Select>)
    const trigger = screen.getByRole("button")
    for (const key of ["ArrowDown", "ArrowUp", "Enter"]) fireEvent.keyDown(trigger, { key })
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it("keeps filtered navigation valid when there are no matches, then accepts a new match", () => {
    const onSelectionChange = vi.fn()
    render(
      <Autocomplete defaultItems={[{ key: "alpha" }, { key: "beta" }]} onSelectionChange={onSelectionChange}>
        {(item) => <AutocompleteItem value={item.key}>{item.key}</AutocompleteItem>}
      </Autocomplete>,
    )
    const input = screen.getByRole("textbox")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "missing" } })
    fireEvent.keyDown(input, { key: "ArrowUp" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSelectionChange).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "be" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("beta")
    expect(input).toHaveValue("beta")
    expect(screen.queryByRole("button", { name: "beta" })).not.toBeInTheDocument()
  })
})
