import type { CardProps } from "./ui/index.js"
import { Card, CardBody, CardHeader, Divider, Input, Switch } from "./ui/index.js"
import React from "react"
import { PASTE_NAME_LEN, PRIVATE_PASTE_NAME_LEN } from "../../shared/constants.js"
import type { PublicEnv } from "../../shared/interfaces.js"
import { InfoTooltip } from "./InfoTooltip.js"
import {
  validatePasteSetting,
  type PasteSetting,
  type TransferMethod,
  managedLinkType,
  normalizeArchiveCompression,
  switchPasteTransferMethod,
} from "../utils/pasteSetting.js"
import { getContentPackagingInfo } from "../utils/content.js"
import { OpticalSettingsFields } from "./OpticalSettingsFields.js"
import { SegmentedControl } from "./SegmentedControl.js"

export type { PasteSetting } from "../utils/pasteSetting.js"

interface PasteSettingPanelProps extends CardProps {
  setting: PasteSetting
  files?: File[]
  /** True when the editor has non-empty text content (a single logical paste). */
  hasEditContent?: boolean
  onSettingChange: (setting: PasteSetting) => void
  config: PublicEnv
  footer?: React.ReactNode
}

const URL_KIND_OPTIONS = [
  { value: "short", label: "Short" },
  { value: "long", label: "Long" },
] as const

const TRANSFER_METHOD_OPTIONS: { value: TransferMethod; label: string }[] = [
  { value: "upload", label: "Upload" },
  { value: "p2p", label: "P2P" },
  { value: "optical", label: "QR" },
]

const ARCHIVE_COMPRESSION_OPTIONS = [
  { value: "deflate", label: "Deflate", description: "Universal ZIP compatibility." },
  { value: "zstd", label: "Zstd", description: "Faster and smaller using modern ZIP tools." },
] as const

function SettingLabel({
  label,
  tooltipLabel,
  children,
}: {
  label: string
  tooltipLabel: string
  children: React.ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center text-sm text-default-600">
      <span>{label}</span>
      <InfoTooltip compact label={tooltipLabel}>
        {children}
      </InfoTooltip>
    </div>
  )
}

function BooleanSettingRow({
  label,
  tooltipLabel,
  tooltip,
  selected,
  onValueChange,
}: {
  label: string
  tooltipLabel: string
  tooltip: React.ReactNode
  selected: boolean
  onValueChange: (value: boolean) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <SettingLabel label={label} tooltipLabel={tooltipLabel}>
        {tooltip}
      </SettingLabel>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Switch aria-label={label} isSelected={selected} onValueChange={onValueChange} />
        <span aria-label={`${label} status`} className="w-8 text-sm text-default-500">
          {selected ? "on" : "off"}
        </span>
      </div>
    </div>
  )
}

function urlKindDescription(kind: (typeof URL_KIND_OPTIONS)[number]["value"]): string {
  switch (kind) {
    case "short":
      return `Random ${PASTE_NAME_LEN}-character name`
    case "long":
      return `Random ${PRIVATE_PASTE_NAME_LEN}-character name`
  }
}

function urlKindExample(kind: (typeof URL_KIND_OPTIONS)[number]["value"], deployUrl: string): string {
  switch (kind) {
    case "short":
      return `${deployUrl}/BxWH2a`
    case "long":
      return `${deployUrl}/5HQWYNmjA4h44SmybeThXXAm`
  }
}

export function PanelSettingsPanel({
  setting,
  files = [],
  hasEditContent = false,
  onSettingChange,
  config,
  footer,
  ...rest
}: PasteSettingPanelProps) {
  const isP2P = setting.transferMethod === "p2p"
  const isUpload = setting.transferMethod === "upload"
  const optical = setting.optical
  const isOptical = setting.transferMethod === "optical"
  const packaging = getContentPackagingInfo(files, hasEditContent)
  // A single file or non-empty text edit is one logical paste, so the user can
  // choose whether to wrap it in a ZIP archive.
  const archiveEnabled =
    isOptical || packaging.hasMultipleFiles || (packaging.hasSingleContent && (setting.compressSingleFile ?? false))
  const archiveSwitchLocked = isOptical || packaging.hasMultipleFiles || !packaging.hasSingleContent
  const isPassthrough = packaging.isSinglePrecompressedFile
  const compressStatus = !archiveEnabled ? "off" : isPassthrough ? "pass" : "on"
  const validation = validatePasteSetting(setting, config)
  const [isExpirationValid, expirationMessage] = validation.expiration
  const [isReadLimitValid, readLimitMessage] = validation.readLimit
  const selectedUrlKind = setting.uploadKind === "manage" ? managedLinkType(setting.manageUrl) : setting.uploadKind
  const expirationDescription =
    isP2P && isExpirationValid ? expirationMessage.replace(/^Expires/, "Pair link expires") : expirationMessage
  const setTransferMethod = (transferMethod: TransferMethod) => {
    onSettingChange(switchPasteTransferMethod(setting, transferMethod, config))
  }

  const urlKindControl = (
    <SegmentedControl
      ariaLabel="URL kind"
      options={URL_KIND_OPTIONS}
      value={selectedUrlKind}
      onChange={(uploadKind) => onSettingChange({ ...setting, uploadKind })}
      tooltipContent={(option) => (
        <div className="max-w-[22rem] px-1 py-1 text-sm">
          <div>{urlKindDescription(option.value)}</div>
          <div className="mt-1 font-mono text-xs opacity-80 break-all">
            e.g. {urlKindExample(option.value, config.DEPLOY_URL)}
          </div>
        </div>
      )}
    />
  )

  return (
    <Card aria-label="Pastebin setting panel" {...rest}>
      <CardHeader className="flex items-center justify-between gap-3 pb-2">
        <span className="text-2xl">Settings</span>
      </CardHeader>
      <Divider />
      <CardBody>
        <div className="flex min-w-0 items-center gap-2">
          <SettingLabel label="Transfer" tooltipLabel="More information about transfer methods">
            Upload saves content on the server. P2P transfers directly between browsers via WebRTC. QR Transfer Streams
            content screen-to-camera 100% offline.
          </SettingLabel>
          <SegmentedControl
            ariaLabel="Transfer method"
            options={TRANSFER_METHOD_OPTIONS}
            value={setting.transferMethod}
            onChange={setTransferMethod}
            className="ml-auto w-full max-w-[360px]"
            buttonClassName="px-1 sm:px-2"
          />
        </div>
        <div className="mt-4 flex min-w-0 items-center gap-2">
          <SettingLabel label="Compress" tooltipLabel="More information about archive compression">
            Compress contents. Deflate offers maximum compatibility, while Zstd delivers smaller files and faster speeds
            on modern software.
          </SettingLabel>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <Switch
              aria-label="Compress as ZIP"
              disabled={archiveSwitchLocked}
              className={`${archiveSwitchLocked ? "opacity-60 " : ""}shrink-0`}
              isSelected={archiveEnabled}
              onValueChange={(compressSingleFile) => onSettingChange({ ...setting, compressSingleFile })}
            />
            <span aria-label="Compression status" className="w-8 shrink-0 text-sm text-default-500">
              {compressStatus}
            </span>
            <SegmentedControl
              ariaLabel="Archive compression"
              options={ARCHIVE_COMPRESSION_OPTIONS}
              value={isOptical ? "zstd" : setting.archiveCompression}
              disabled={isOptical}
              onChange={(archiveCompression) =>
                onSettingChange({ ...setting, archiveCompression: normalizeArchiveCompression(archiveCompression) })
              }
              tooltipContent={(option) => <div className="px-1 py-1 text-sm">{option.description}</div>}
            />
          </div>
        </div>
        <Divider className="my-3" />
        {isOptical ? (
          <OpticalSettingsFields
            settings={optical}
            onSettingsChange={(nextOptical) => onSettingChange({ ...setting, optical: nextOptical })}
          />
        ) : (
          <div className="flex flex-wrap gap-4">
            <Input
              type="text"
              label="Expiration"
              labelExtra={
                <InfoTooltip label="More information about Expiration" compact>
                  {isP2P
                    ? "New receivers can pair before the link expires. Ongoing transfers will not be interrupted."
                    : "Available before it expires."}
                </InfoTooltip>
              }
              classNames={{
                base: "flex-1 basis-[calc(50%-0.5rem)]",
              }}
              value={setting.expiration}
              isRequired
              onValueChange={(e) => onSettingChange({ ...setting, expiration: e })}
              isInvalid={!isExpirationValid}
              errorMessage={expirationMessage}
              description={expirationDescription}
            />
            <Input
              type="number"
              min={0}
              step={1}
              label={isP2P ? "Transfers" : "Reads"}
              labelExtra={
                <InfoTooltip
                  label={isP2P ? "More information about Transfers" : "More information about Reads"}
                  compact
                >
                  {isP2P
                    ? "Max successful receivers for this session. Re-downloads don't count. Set to 0 for unlimited."
                    : "Maximum reads before the paste expires. 0 allows unlimited reads."}
                </InfoTooltip>
              }
              value={setting.readLimit}
              onValueChange={(v) => onSettingChange({ ...setting, readLimit: v })}
              isInvalid={!isReadLimitValid}
              errorMessage={readLimitMessage}
              description={readLimitMessage}
              classNames={{
                base: "flex-1 basis-[calc(50%-0.5rem)]",
              }}
            />
          </div>
        )}
        {(isP2P || isUpload) && (
          <>
            <Divider className="my-3" />
            <BooleanSettingRow
              label={isP2P ? "Verify data integrity" : "End-to-end encryption"}
              tooltipLabel={
                isP2P ? "More information about integrity verification" : "More information about end-to-end encryption"
              }
              tooltip={
                isP2P ? (
                  "Verifies transfers per 4 MB block and resends mismatched chunks."
                ) : (
                  <>
                    <h3 className="mb-2 font-bold">End-to-end encryption</h3>
                    <div>
                      The decryption key is in the URL hash and never hits our server—only holders of the link can read
                      the content.
                    </div>
                    <div className="mt-2 text-yellow-600">
                      Only content is encrypted; filename and file type remain visible.
                    </div>
                  </>
                )
              }
              selected={isP2P ? setting.verifyP2P : setting.doEncrypt}
              onValueChange={(value) =>
                onSettingChange(isP2P ? { ...setting, verifyP2P: value } : { ...setting, doEncrypt: value })
              }
            />
          </>
        )}
        {(isP2P || isUpload) && (
          <>
            <Divider className="my-3" />
            <div className="flex min-w-0 items-center gap-2">
              <SettingLabel label="Link type" tooltipLabel="More information about link length">
                Set random URL length. Longer URLs offer stronger protection against guessing.
              </SettingLabel>
              <div className="ml-auto min-w-0">{urlKindControl}</div>
            </div>
          </>
        )}
      </CardBody>
      {footer}
    </Card>
  )
}
