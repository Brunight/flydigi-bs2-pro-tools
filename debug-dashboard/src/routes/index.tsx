import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CommandCard } from '#/components/CommandCard'
import { LightingCard } from '#/components/LightingCard'
import { LogPanel } from '#/components/LogPanel'
import { StatusPanel } from '#/components/StatusPanel'
import { Button, useAction } from '#/components/ui'
import { GROUPS } from '#/lib/commands'
import type { CoolerState } from '#/lib/types'
import { connect, disconnect, getState, turnOff, turnOn } from '#/server/functions'

const POLL_MS = 500

export const Route = createFileRoute('/')({
  loader: () => getState(),
  component: Home,
})

// The server holds the connection; the page just polls its state.
function useCoolerState(initial: CoolerState) {
  const [state, setState] = useState(initial)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const next = await getState()
        if (alive) setState(next)
      } catch {
        // server restarting; try again next tick
      }
      if (alive) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])
  return state
}

const BADGE: Record<CoolerState['connection'], string> = {
  disconnected: 'bg-slate-700 text-slate-300',
  scanning: 'bg-amber-900 text-amber-300',
  connecting: 'bg-amber-900 text-amber-300',
  connected: 'bg-emerald-900 text-emerald-300',
}

function Home() {
  const state = useCoolerState(Route.useLoaderData())
  const connected = state.connection === 'connected'
  const { busy, run } = useAction()

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-50">Flydigi Cooler</h1>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE[state.connection]}`}>
          {state.connection}
          {state.deviceName && ` · ${state.deviceName}`}
        </span>
        <div className="ml-auto flex gap-2">
          {state.connection === 'disconnected' ? (
            <>
              <Button disabled={busy} onClick={() => run(() => connect())}>
                Connect
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => turnOn())}>
                Turn on
              </Button>
            </>
          ) : (
            <>
              <Button disabled={busy || !connected} onClick={() => run(() => disconnect())}>
                Disconnect
              </Button>
              <Button variant="danger" disabled={busy || !connected} onClick={() => run(() => turnOff())}>
                Turn off
              </Button>
            </>
          )}
        </div>
      </header>
      {state.error && state.connection === 'disconnected' && (
        <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{state.error}</p>
      )}

      <StatusPanel status={state.status} connected={connected} />

      <div className="grid gap-4 lg:grid-cols-2">
        {GROUPS.map((g) => (
          <CommandCard key={g} group={g} replies={state.replies} connected={connected} />
        ))}
        <LightingCard connected={connected} />
      </div>

      <LogPanel log={state.log} />
    </main>
  )
}
