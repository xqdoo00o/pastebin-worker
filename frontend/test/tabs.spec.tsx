import { useState } from "react"
import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { userEvent } from "@testing-library/user-event"
import { Tab, Tabs } from "../components/ui/Tabs.js"
import "@testing-library/jest-dom/vitest"

afterEach(cleanup)

it("switches tabs and focus with arrows and Home/End while keeping one Tab stop", async () => {
  function Example() {
    const [selectedKey, setSelectedKey] = useState("a")
    return (
      <>
        <Tabs selectedKey={selectedKey} onSelectionChange={setSelectedKey}>
          {["a", "b", "c"].map((key) => (
            <Tab key={key} title={key}>
              {key} content
            </Tab>
          ))}
        </Tabs>
        <button>After tabs</button>
      </>
    )
  }
  render(<Example />)
  await userEvent.tab()
  expect(screen.getByRole("tab", { name: "a" })).toHaveFocus()
  for (const [key, selected] of [
    ["ArrowRight", "b"],
    ["ArrowRight", "c"],
    ["ArrowRight", "a"],
    ["ArrowLeft", "c"],
    ["Home", "a"],
    ["End", "c"],
  ]) {
    fireEvent.keyDown(document.activeElement!, { key })
    expect(screen.getByRole("tab", { name: selected })).toHaveFocus()
    expect(screen.getByRole("tab", { name: selected })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tabpanel")).toHaveTextContent(`${selected} content`)
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1)
  }
  await userEvent.tab()
  expect(screen.getByRole("button", { name: "After tabs" })).toHaveFocus()
})
