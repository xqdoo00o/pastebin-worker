import React, { useRef } from "react"
import { FieldLabel, fieldControlSizeClass, InputClearButton, type FieldSize } from "./FieldPrimitives.js"

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string
  labelExtra?: React.ReactNode
  size?: FieldSize
  description?: string
  errorMessage?: string
  warningMessage?: string
  successMessage?: string
  isInvalid?: boolean
  isRequired?: boolean
  isClearable?: boolean
  color?: "default" | "success"
  startContent?: React.ReactNode
  endContent?: React.ReactNode
  onValueChange?: (value: string) => void
  onClear?: () => void
  classNames?: {
    base?: string
    label?: string
    input?: string
    box?: string
    description?: string
    errorMessage?: string
  }
}

export function Input({
  label,
  labelExtra,
  size = "md",
  description,
  errorMessage,
  warningMessage,
  successMessage,
  isInvalid,
  isRequired,
  isClearable,
  color = "default",
  startContent,
  endContent,
  onValueChange,
  onClear,
  className = "",
  classNames = {},
  onChange,
  value,
  ...rest
}: InputProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange?.(e)
    onValueChange?.(e.target.value)
  }

  const handleClear = () => {
    onValueChange?.("")
    onClear?.()
    inputRef.current?.focus()
  }

  const showClearButton = isClearable && value !== undefined && value !== ""

  const borderColor = isInvalid
    ? "border-danger focus-within:border-danger"
    : color === "success"
      ? "border-success focus-within:border-success"
      : "border-default-200 focus-within:border-default-400 hover:border-default-400"
  const boxBg = color === "success" ? "bg-success-50" : "bg-default-100"

  return (
    <div className={`flex flex-col gap-1.5 min-w-0 ${className} ${classNames.base || ""}`}>
      {label && (
        <FieldLabel className={`inline-flex w-fit items-center ${classNames.label || ""}`}>
          {label}
          {isRequired && <span className="ml-1 text-red-500">*</span>}
          {labelExtra}
        </FieldLabel>
      )}
      <div
        className={`flex items-center ${boxBg} border rounded-xl ${borderColor} ${startContent || endContent || showClearButton ? "pl-3 pr-1" : ""} ${classNames.box || ""}`}
      >
        {startContent && <div className="flex-shrink-0">{startContent}</div>}
        <input
          ref={inputRef}
          aria-label={label}
          aria-invalid={isInvalid}
          className={`min-w-0 flex-1 bg-transparent text-foreground focus:outline-none ${fieldControlSizeClass[size]} ${startContent || endContent || showClearButton ? "" : "px-3"} ${classNames.input || ""}`}
          onChange={handleChange}
          value={value}
          {...rest}
        />
        {showClearButton && <InputClearButton onMouseDown={(e) => e.preventDefault()} onClick={handleClear} />}
        {endContent && <div className="inline-flex flex-shrink-0 items-center">{endContent}</div>}
      </div>
      {(description || errorMessage || warningMessage || successMessage) && (
        <div
          className={`pl-1 text-xs ${
            isInvalid ? "text-danger" : warningMessage ? "text-yellow-600" : "text-default-500"
          } ${classNames.description || classNames.errorMessage || ""}`}
        >
          {isInvalid ? errorMessage : warningMessage || successMessage || description}
        </div>
      )}
    </div>
  )
}
