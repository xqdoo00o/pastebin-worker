import { useEffect, useState, type ReactNode } from "react"
import type { OpticalTransferSettings } from "../optical/shared/settings.js"
import {
  OPTICAL_ECC_OPTIONS,
  OPTICAL_GRID_LABELS,
  OPTICAL_GRID_OPTIONS,
  TX_FPS_OPTIONS,
  frameBytesOptionsForEcc,
  normalizeFrameBytesForEcc,
} from "../optical/shared/settings.js"
import { InfoTooltip } from "./InfoTooltip.js"
import { NativeSelectField } from "./ui/index.js"

const DISPLAY_RATE_SAMPLE_INTERVALS = 60

function displayTxFpsLimit(refreshRate: number): number | undefined {
  if (!Number.isFinite(refreshRate) || refreshRate <= 0) return undefined
  return TX_FPS_OPTIONS.reduce((closest, option) => {
    const distance = Math.abs(option - refreshRate)
    const closestDistance = Math.abs(closest - refreshRate)
    return distance < closestDistance ? option : closest
  })
}

function logDisplayRefreshRateEstimate(onEstimate: (refreshRate: number) => void): () => void {
  if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") return () => undefined

  const intervals: number[] = []
  let previousTimestamp: number | undefined
  let animationFrame = 0
  let stopped = false

  const sample = (timestamp: number) => {
    if (stopped) return
    if (previousTimestamp !== undefined) {
      const interval = timestamp - previousTimestamp
      if (interval > 0) intervals.push(interval)
    }
    previousTimestamp = timestamp

    if (intervals.length < DISPLAY_RATE_SAMPLE_INTERVALS) {
      animationFrame = requestAnimationFrame(sample)
      return
    }

    const sorted = [...intervals].sort((a, b) => a - b)
    const middle = sorted.length / 2
    const medianInterval = (sorted[middle - 1] + sorted[middle]) / 2
    const refreshRate = 1000 / medianInterval
    console.info(`[optical] Estimated display refresh rate: ${refreshRate.toFixed(1)} Hz (requestAnimationFrame)`)
    onEstimate(refreshRate)
  }

  animationFrame = requestAnimationFrame(sample)
  return () => {
    stopped = true
    cancelAnimationFrame(animationFrame)
  }
}

export interface OpticalSettingsFieldsProps {
  settings: OpticalTransferSettings
  onSettingsChange: (settings: OpticalTransferSettings) => void
  className?: string
}

function OpticalSelectField({
  label,
  tooltipLabel,
  tooltip,
  ariaLabel,
  value,
  options,
  onValueChange,
  optionLabel = String,
}: {
  label: string
  tooltipLabel: string
  tooltip: ReactNode
  ariaLabel: string
  value: string | number
  options: readonly (string | number)[]
  onValueChange: (value: string) => void
  optionLabel?: (value: string | number) => ReactNode
}) {
  return (
    <NativeSelectField
      label={label}
      labelExtra={
        <InfoTooltip compact label={tooltipLabel}>
          {tooltip}
        </InfoTooltip>
      }
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {optionLabel(option)}
        </option>
      ))}
    </NativeSelectField>
  )
}

export function OpticalSettingsFields({
  settings,
  onSettingsChange,
  className = "grid grid-cols-2 gap-3 sm:grid-cols-4",
}: OpticalSettingsFieldsProps) {
  const [maxTxFps, setMaxTxFps] = useState<number>()
  useEffect(() => logDisplayRefreshRateEstimate((refreshRate) => setMaxTxFps(displayTxFpsLimit(refreshRate))), [])
  useEffect(() => {
    if (maxTxFps === undefined || settings.txFps <= maxTxFps) return
    onSettingsChange({ ...settings, txFps: maxTxFps })
  }, [maxTxFps, onSettingsChange, settings])

  const availableTxFpsOptions =
    maxTxFps === undefined ? TX_FPS_OPTIONS : TX_FPS_OPTIONS.filter((value) => value <= maxTxFps)
  const compatibleFrameBytes = frameBytesOptionsForEcc(settings.ecc)
  const update = (change: Partial<OpticalTransferSettings>) => onSettingsChange({ ...settings, ...change })

  return (
    <div className={className}>
      <OpticalSelectField
        label="TX FPS"
        tooltipLabel="More information about TX FPS"
        tooltip="Sets the QR frame rate. Higher values increase transfer speed, but require a capable display and camera."
        ariaLabel="Optical TX FPS"
        value={settings.txFps}
        options={availableTxFpsOptions}
        onValueChange={(value) => update({ txFps: Number(value) })}
      />
      <OpticalSelectField
        label="B/Frame"
        tooltipLabel="More information about bytes per frame"
        tooltip="Data payload per QR frame. Higher values boost transfer speed, but increase code density and make scanning harder."
        ariaLabel="Optical bytes per frame"
        value={settings.frameBytes}
        options={compatibleFrameBytes}
        onValueChange={(value) => update({ frameBytes: Number(value) })}
      />
      <OpticalSelectField
        label="ECC"
        tooltipLabel="More information about error correction"
        tooltip="Higher error correction improves noise tolerance, but reduces the data payload per QR frame."
        ariaLabel="Optical error correction"
        value={settings.ecc}
        options={OPTICAL_ECC_OPTIONS}
        onValueChange={(value) => {
          const ecc = value as OpticalTransferSettings["ecc"]
          update({ ecc, frameBytes: normalizeFrameBytesForEcc(settings.frameBytes, ecc) })
        }}
      />
      <OpticalSelectField
        label="Layout"
        tooltipLabel="More information about QR layout"
        tooltip="Concurrent QR codes. Higher counts increase transfer speed, but require clearer displays and cameras."
        ariaLabel="Optical QR layout"
        value={settings.gridCodes}
        options={OPTICAL_GRID_OPTIONS}
        onValueChange={(value) => update({ gridCodes: Number(value) as OpticalTransferSettings["gridCodes"] })}
        optionLabel={(value) => OPTICAL_GRID_LABELS[value as OpticalTransferSettings["gridCodes"]]}
      />
    </div>
  )
}
