import type { ReactNode } from 'react'

const TONE_CLASS = {
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
} as const

interface NoticeProps {
  tone?: keyof typeof TONE_CLASS
  /** `alert` for a notice that appears in response to something, such as a failed request. */
  role?: 'alert'
  className?: string
  children: ReactNode
}

/** A bordered, tinted box for a warning or an error next to the thing it is about. */
export default function Notice({ tone = 'warning', role, className = '', children }: NoticeProps) {
  return (
    <div
      role={role}
      className={`${TONE_CLASS[tone]} rounded-2xl border px-4 py-3 text-sm ${className}`}
    >
      {children}
    </div>
  )
}
