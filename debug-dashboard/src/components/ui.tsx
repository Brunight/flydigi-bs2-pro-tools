import { useState, type ReactNode } from 'react'

export function Card({ title, children, tone }: { title: string; children: ReactNode; tone?: 'danger' }) {
  return (
    <section
      className={`rounded-xl border p-4 ${tone === 'danger' ? 'border-red-900 bg-red-950/30' : 'border-slate-800 bg-slate-900'}`}
    >
      <h2 className={`mb-3 text-sm font-semibold uppercase tracking-wide ${tone === 'danger' ? 'text-red-400' : 'text-slate-400'}`}>
        {title}
      </h2>
      {children}
    </section>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'primary' | 'danger'
}) {
  const colors = {
    default: 'bg-slate-700 hover:bg-slate-600',
    primary: 'bg-sky-600 hover:bg-sky-500',
    danger: 'bg-red-700 hover:bg-red-600',
  }[variant]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${colors}`}
    >
      {children}
    </button>
  )
}

export const inputClass =
  'rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100 focus:border-sky-500 focus:outline-none'

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Runs a server call, tracking busy state and the last error.
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}
