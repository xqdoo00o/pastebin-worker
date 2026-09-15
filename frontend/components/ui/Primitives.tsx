import type React from "react"

export type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement>

export function Link({ children, className = "", ...rest }: LinkProps) {
  return (
    <a className={`text-primary hover:opacity-80 transition-opacity ${className}`} {...rest}>
      {children}
    </a>
  )
}

export function PageShell({ className = "", ...props }: React.HTMLAttributes<HTMLElement>) {
  return <main className={`flex min-h-screen flex-col items-center ${className}`} {...props} />
}

export function PageContainer({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`w-full ${className}`} {...props} />
}

export function PageTopbar({
  heading,
  actions,
  className = "",
  headingClassName = "",
  ...props
}: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  heading: React.ReactNode
  actions: React.ReactNode
  headingClassName?: string
}) {
  return (
    <header className={`my-4 flex min-w-0 items-center justify-between gap-4 ${className}`} {...props}>
      <h1
        className={`inline-flex min-w-0 flex-1 items-center overflow-hidden text-xl font-normal md:items-baseline md:text-2xl ${headingClassName}`}
      >
        {heading}
      </h1>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </header>
  )
}

export type DividerProps = React.HTMLAttributes<HTMLHRElement>

export function Divider({ className = "", ...rest }: DividerProps) {
  return <hr className={`border-t-1 border-default-200 ${className}`} {...rest} />
}

export type CardProps = React.HTMLAttributes<HTMLDivElement>

export function Card({ children, className = "", ...rest }: CardProps) {
  return (
    <div className={`rounded-2xl bg-content1 shadow-medium ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className = "", ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`px-4 py-3 ${className}`} {...rest}>
      {children}
    </div>
  )
}

export function CardBody({ children, className = "", ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`px-4 py-3 ${className}`} {...rest}>
      {children}
    </div>
  )
}

interface PanelCardProps extends Omit<CardProps, "title"> {
  title: React.ReactNode
  headerEnd?: React.ReactNode
  bodyClassName?: string
}

/** Shared shell for the transfer/result cards used across the frontend entries. */
export function PanelCard({ title, headerEnd, bodyClassName = "", children, className, ...rest }: PanelCardProps) {
  return (
    <Card className={className} {...rest}>
      <CardHeader className={headerEnd ? "flex items-center justify-between gap-3 pb-2 text-2xl" : "pb-2 text-2xl"}>
        {headerEnd ? <span>{title}</span> : title}
        {headerEnd}
      </CardHeader>
      <Divider />
      <CardBody className={bodyClassName}>{children}</CardBody>
    </Card>
  )
}

export function PanelLoadingState({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex flex-col items-center justify-center gap-2 py-4 ${className}`} {...props} />
}

export function StatusBanner({
  tone = "primary",
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: "primary" | "danger" }) {
  const toneClass = tone === "danger" ? "bg-danger-50 text-danger" : "bg-primary-50 text-primary"
  return <div className={`rounded-lg px-3 py-2 text-sm ${toneClass} ${className}`} {...props} />
}

export interface CircularProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number
  label?: string
}

export function CircularProgress({ value, label, className = "", ...rest }: CircularProgressProps) {
  const radius = 20
  const circumference = 2 * Math.PI * radius
  const progress = value !== undefined ? ((100 - value) / 100) * circumference : circumference * 0.25

  return (
    <div className={`inline-flex flex-col items-center gap-2 ${className}`} {...rest}>
      <svg width="48" height="48" viewBox="0 0 48 48" className="animate-spin">
        <circle cx="24" cy="24" r={radius} fill="none" stroke="currentColor" strokeWidth="4" opacity="0.25" />
        <circle
          cx="24"
          cy="24"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={progress}
          strokeLinecap="round"
          transform="rotate(-90 24 24)"
        />
      </svg>
      {label && <span className="text-sm">{label}</span>}
    </div>
  )
}

export interface NativeSelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: React.ReactNode
  labelExtra?: React.ReactNode
  wrapperClassName?: string
  labelClassName?: string
  selectClassName?: string
  variant?: "default" | "receiver" | "compact"
}

const nativeSelectClass: Record<NonNullable<NativeSelectFieldProps["variant"]>, string> = {
  default:
    "h-10 w-full rounded-xl border border-default-200 bg-default-100 px-3 text-sm text-foreground transition-colors hover:border-default-400 focus:border-default-400 focus:outline-none",
  receiver: "h-10 min-w-0 rounded-xl border border-default-300 bg-content1 px-2.5 text-base text-foreground",
  compact:
    "h-10 w-16 rounded-xl border border-default-200 bg-default-100 px-3 text-sm text-foreground transition-colors hover:border-default-400 focus:border-default-400 focus:outline-none",
}

/** Labelled native select used where direct DOM access or native mobile pickers
 * are preferable to the custom listbox component. */
export function NativeSelectField({
  label,
  labelExtra,
  wrapperClassName = "",
  labelClassName = "",
  selectClassName = "",
  variant = "default",
  children,
  ...selectProps
}: NativeSelectFieldProps) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${wrapperClassName}`}>
      <span className={`inline-flex w-fit items-center pl-1 text-sm text-default-500 ${labelClassName}`}>
        {label}
        {labelExtra}
      </span>
      <select className={`${nativeSelectClass[variant]} ${selectClassName}`} {...selectProps}>
        {children}
      </select>
    </label>
  )
}
