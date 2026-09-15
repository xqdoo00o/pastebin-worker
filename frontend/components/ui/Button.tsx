import React from "react"

export type ActionButtonVariant = "primary" | "secondary" | "tertiary" | "danger"
type ButtonVariant = "solid" | "ghost" | "light" | ActionButtonVariant

export const iconControlClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full p-1.5 text-default-600 no-underline transition-colors hover:bg-default-100 hover:no-underline"

const actionVariantClass: Record<ActionButtonVariant, string> = {
  primary: "primary-button border-0 bg-primary text-primary-foreground hover:opacity-80 focus-visible:opacity-80",
  secondary: "secondary-button border-0 bg-primary-50 text-primary hover:bg-primary-100 focus-visible:bg-primary-100",
  tertiary:
    "tertiary-button border border-default-200 bg-transparent text-foreground hover:bg-default-200 focus-visible:bg-default-200",
  danger: "danger-button border-0 bg-danger-50 text-danger hover:bg-danger-100 focus-visible:bg-danger-100",
}

export function actionControlClassName(variant: ActionButtonVariant = "primary", isIconOnly = false): string {
  const shapeClass = isIconOnly
    ? "icon-only-button size-10 min-w-10 shrink-0 p-2"
    : `min-h-10 px-4 py-2.5 ${variant === "primary" ? "min-w-[min(100%,12rem)]" : ""}`
  return `inline-flex cursor-pointer items-center justify-center rounded-xl text-sm font-medium leading-5 transition-[background-color,border-color,color,opacity] disabled:cursor-not-allowed disabled:opacity-50 ${shapeClass} ${actionVariantClass[variant]}`
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isIconOnly?: boolean
  onPress?: () => void
  variant?: ButtonVariant
  color?: "primary" | "danger"
  size?: "sm" | "md" | "lg"
  isDisabled?: boolean
}

export function Button({
  children,
  className = "",
  isIconOnly,
  onPress,
  variant = "solid",
  color = "primary",
  size = "md",
  isDisabled,
  disabled,
  onClick,
  ...rest
}: ButtonProps) {
  const isActionVariant = variant in actionVariantClass
  const baseClass = `inline-flex cursor-pointer items-center justify-center ${isIconOnly ? "rounded-full" : "rounded-xl"} disabled:cursor-not-allowed disabled:opacity-50`

  const variantClass = isActionVariant
    ? ""
    : variant === "solid"
      ? color === "danger"
        ? "bg-danger text-white hover:opacity-80"
        : "bg-primary text-primary-foreground hover:opacity-80"
      : variant === "ghost"
        ? "border border-default-300 hover:bg-default-100"
        : "hover:bg-default-100"

  const sizeClass = isActionVariant
    ? ""
    : isIconOnly
      ? { sm: "p-1.5", md: "p-2", lg: "p-2.5" }[size]
      : { sm: "px-3 py-1.5 text-sm", md: "px-4 py-2 text-sm", lg: "px-6 py-3 text-base" }[size]

  return (
    <button
      className={`${isActionVariant ? actionControlClassName(variant as ActionButtonVariant, isIconOnly) : `${baseClass} ${variantClass} ${sizeClass}`} ${className}`}
      disabled={isDisabled || disabled}
      onClick={onPress || onClick}
      {...rest}
    >
      {children}
    </button>
  )
}

export interface ActionButtonProps extends Omit<ButtonProps, "variant" | "color" | "size"> {
  variant?: ActionButtonVariant
}

export function ActionButton({ variant = "primary", ...props }: ActionButtonProps) {
  return <Button variant={variant} {...props} />
}
