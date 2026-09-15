import React from "react"

export interface TabsProps {
  selectedKey: string
  onSelectionChange: (key: string) => void
  children: React.ReactNode
  classNames?: {
    base?: string
    tabList?: string
    tab?: string
    panel?: string
  }
}

export function Tabs({ selectedKey, onSelectionChange, children, classNames = {} }: TabsProps) {
  const tabs = React.Children.toArray(children).filter((child): child is React.ReactElement =>
    React.isValidElement(child),
  )
  const keyForTab = (tab: React.ReactElement, index: number) =>
    tab.key?.toString().replace(/^\.\$/, "") || `tab-${index}`
  const selectedTab = tabs.find((tab, index) => selectedKey === keyForTab(tab, index))
  const selectedTabProps = selectedTab?.props as TabProps | undefined

  return (
    <div className={classNames.base}>
      <div role="tablist" className={`flex ${classNames.tabList || ""}`}>
        {tabs.map((tab, index) => {
          const tabKey = keyForTab(tab, index)
          const isSelected = selectedKey === tabKey
          return (
            <button
              key={tabKey}
              type="button"
              role="tab"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelectionChange(tabKey)}
              className={`cursor-pointer rounded-sm text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-default-400 ${isSelected ? "text-default-700" : "text-default-500 hover:text-default-700"} ${classNames.tab || ""}`}
            >
              <span className="relative inline-block pb-1">
                {(tab.props as TabProps).title}
                {isSelected && (
                  <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-[2px] bg-default-700" />
                )}
              </span>
            </button>
          )
        })}
      </div>
      <div role="tabpanel" className={`${classNames.panel || ""} ${selectedTabProps?.className || ""}`}>
        {selectedTabProps?.children}
      </div>
    </div>
  )
}

export interface TabProps {
  title: string
  children: React.ReactNode
  className?: string
}

export function Tab({ children, className = "" }: TabProps) {
  return <div className={className}>{children}</div>
}
