import type React from "react"
import { useState } from "react"

import type { CardProps } from "./ui/index.js"
import { Input, PanelCard } from "./ui/index.js"

import type { PasteResponse } from "../../shared/interfaces.js"
import { makeDisplayUrl, withPathPrefix } from "../utils/pasteUrls.js"
import type { UploadProgress } from "../utils/uploader.js"
import { formatSize } from "../utils/utils.js"
import { InfoTooltip } from "./InfoTooltip.js"
import { ShareUrlField } from "./ShareUrlField.js"
import { ChevronDownIcon } from "./icons.js"
import { TransferLoadingState } from "./TransferLoadingState.js"

interface UploadedPanelProps extends CardProps {
  isLoading: boolean
  loadingProgress?: UploadProgress
  onCancel?: () => void
  pasteResponse?: PasteResponse
  encryptionKey?: string
  highlightLang?: string
  isUrlPaste?: boolean
}

const RAW_URL_FLAGS: { syntax: string; desc: string }[] = [
  { syntax: "?mime=…", desc: "Override the Content-Type" },
  { syntax: "?a", desc: "Force download (Content-Disposition: attachment)" },
  { syntax: ".png", desc: "Append an extension to hint MIME type" },
  { syntax: "/foo.txt", desc: "Append a filename for the downloaded file" },
]

const DISPLAY_URL_FLAGS: { syntax: string; desc: string }[] = [
  { syntax: "?lang=js", desc: "Override syntax highlighting language" },
  { syntax: "/foo.txt", desc: "Append a filename — shown in the header and used as the download name" },
]

function UrlTooltip({ desc, flags }: { desc?: React.ReactNode; flags?: { syntax: string; desc: string }[] }) {
  return (
    <InfoTooltip label="More information" compact>
      {desc && <div className={flags ? "mb-2" : ""}>{desc}</div>}
      {flags && (
        <>
          <div className="font-medium mb-1">Options:</div>
          <div className="flex flex-col gap-1">
            {flags.map((f) => (
              <div key={f.syntax} className="flex items-baseline gap-2">
                <code className="font-mono text-xs whitespace-nowrap">{f.syntax}</code>
                <span className="text-xs opacity-80">{f.desc}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </InfoTooltip>
  )
}

export function UploadedPanel({
  isLoading,
  loadingProgress,
  onCancel,
  pasteResponse,
  className,
  encryptionKey,
  highlightLang,
  isUrlPaste,
  ...rest
}: UploadedPanelProps) {
  const inputProps = {
    readOnly: true,
    className: "mb-2",
  }
  const [moreOpen, setMoreOpen] = useState<boolean>(false)

  const isEncrypted = Boolean(encryptionKey)
  const isMarkdown = highlightLang === "markdown"

  const urlInput = (
    label: string,
    value: string,
    labelExtra?: React.ReactNode,
    options?: { color?: "default" | "success"; copyClassName?: string; qrClassName?: string },
  ) => {
    return (
      <ShareUrlField
        label={label}
        value={value}
        labelExtra={labelExtra}
        color={options?.color}
        copyClassName={options?.copyClassName}
        qrClassName={options?.qrClassName}
      />
    )
  }

  const markdownUrlField = (pasteResponse: PasteResponse) =>
    urlInput(
      "Markdown URL",
      withPathPrefix(pasteResponse.url, "/a"),
      <InfoTooltip label="More information" compact>
        Render the paste as GitHub-flavored markdown (with code highlighting and LaTeX).
      </InfoTooltip>,
    )

  const displayUrlLabelExtra = (
    <UrlTooltip
      desc={
        <>
          Browser-friendly view with syntax highlighting.
          {encryptionKey && (
            <>
              {" "}
              The decryption key sits after the <code className="font-mono">#</code> in the URL and is never sent to the
              server — it stays in the browser for client-side decryption.
            </>
          )}
        </>
      }
      flags={DISPLAY_URL_FLAGS}
    />
  )
  const displayUrl = pasteResponse ? makeDisplayUrl(pasteResponse.url, encryptionKey) : ""

  return (
    <PanelCard title="Uploaded Paste" className={className} {...rest}>
      {isLoading ? (
        <TransferLoadingState
          progressLabel="Loading..."
          progressValue={
            loadingProgress ? (100 * loadingProgress.doneBytes) / Math.max(loadingProgress.totalBytes, 1) : 50
          }
          onCancel={onCancel}
        >
          {loadingProgress && (
            <span className="text-sm text-default-500 tabular-nums">
              Uploaded {formatSize(loadingProgress.doneBytes)} / {formatSize(loadingProgress.totalBytes)}
            </span>
          )}
        </TransferLoadingState>
      ) : (
        pasteResponse && (
          <>
            {urlInput("Display URL", displayUrl, displayUrlLabelExtra, {
              color: encryptionKey ? "success" : "default",
              copyClassName: encryptionKey ? "bg-success-50 hover:bg-success-100" : "",
              qrClassName: encryptionKey ? "hover:bg-success-100" : "hover:bg-default-200",
            })}
            {isMarkdown && !isEncrypted && markdownUrlField(pasteResponse)}
            {urlInput(
              "Raw URL",
              pasteResponse.url,
              <UrlTooltip
                desc={
                  encryptionKey
                    ? "Returns the raw paste content — encrypted, since this paste uses client-side encryption. Decrypt it yourself with the key."
                    : "Returns the raw paste content directly, with the inferred Content-Type."
                }
                flags={RAW_URL_FLAGS}
              />,
            )}
            {urlInput(
              "Manage URL",
              pasteResponse.manageUrl,
              <InfoTooltip label="More information" compact>
                Use this URL to update or delete the paste later. Keep it private.
              </InfoTooltip>,
            )}
            <Input {...inputProps} label={"Expiration"} value={new Date(pasteResponse.expireAt).toLocaleString()} />

            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-controls="uploaded-paste-more"
              className={
                `mt-1 mb-2 flex items-center gap-1 text-sm text-default-500 cursor-pointer ` +
                "hover:text-default-700 select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-default-400 rounded transition-colors"
              }
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={`h-4 w-4 transition-transform ${moreOpen ? "" : "-rotate-90"}`}
              />
              <span>More</span>
            </button>

            {moreOpen && (
              <div id="uploaded-paste-more">
                {!isEncrypted && !isMarkdown && markdownUrlField(pasteResponse)}
                {!isEncrypted &&
                  isUrlPaste &&
                  urlInput(
                    "Shortener URL",
                    withPathPrefix(pasteResponse.url, "/u"),
                    <InfoTooltip label="More information" compact>
                      The paste body is a URL — this endpoint redirects (302) to it.
                    </InfoTooltip>,
                  )}
                {urlInput(
                  "Metadata URL",
                  withPathPrefix(pasteResponse.url, "/m"),
                  <InfoTooltip label="More information" compact>
                    Get paste metadata (size, timestamps, filename, encryption scheme, ...) as JSON.
                  </InfoTooltip>,
                )}
              </div>
            )}
          </>
        )
      )}
    </PanelCard>
  )
}
