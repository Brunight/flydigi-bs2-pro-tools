import { useState } from 'react'
import { RAMP_NAMES, STANDBY_NAMES, SUPPLY_NAMES, type Status } from '#/lib/protocol'
import { sendCommand, setSpeed } from '#/server/functions'
import { Button, Card, useAction } from './ui'

export function StatusPanel({ status, connected }: { status?: Partial<Status>; connected: boolean }) {
  const [rpm, setRpm] = useState(2400)
  const { busy, error, run } = useAction()

  const s = status ?? {}
  const onOff = (v?: boolean) => (v === undefined ? undefined : v ? 'On' : 'Off')
  const rows = (
    [
      ['State', s.asleep === undefined ? undefined : s.asleep ? 'Asleep' : 'Running'],
      ['Mode', s.realtime ? 'Custom speed' : s.gear ? `Gear ${s.gear}` : undefined],
      ['Target', s.targetRpm === undefined ? undefined : `${s.targetRpm} RPM`],
      ['Power supply', s.supply === undefined ? undefined : SUPPLY_NAMES[s.supply]],
      ['USB host', s.usb === undefined ? undefined : s.usb ? 'Connected' : 'No'],
      ['Auto standby', s.standby === undefined ? undefined : STANDBY_NAMES[s.standby]],
      ['Auto-start', onOff(s.autoStart)],
      ['Light strip', onOff(s.strip)],
      ['Gear LEDs', onOff(s.gearLeds)],
      ['Ramp', s.ramp === undefined ? undefined : (RAMP_NAMES[s.ramp] ?? String(s.ramp))],
      ['Demo mode', s.demo ? 'On (power-cycle to exit)' : undefined],
    ] as [string, string | undefined][]
  ).filter((r): r is [string, string] => r[1] !== undefined)

  return (
    <Card title="Status">
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="min-w-40">
          <div className="text-5xl font-semibold tabular-nums text-slate-50">{s.rpm ?? '—'}</div>
          <div className="text-sm text-slate-400">RPM</div>
        </div>
        {rows.length ? (
          <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt className="text-slate-400">{k}</dt>
                <dd className="text-right text-slate-100">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="flex-1 text-sm text-slate-400">
            {connected ? 'Waiting for the first status update…' : 'Connect to see live status.'}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
        {[1, 2, 3, 4].map((g) => (
          <Button
            key={g}
            disabled={!connected || busy}
            variant={!s.realtime && s.gear === g ? 'primary' : 'default'}
            onClick={() => run(() => sendCommand({ data: { code: 0x08, values: { gear: String(g) } } }))}
          >
            Gear {g}
          </Button>
        ))}
        <span className="mx-2 h-6 w-px bg-slate-700" />
        <input
          type="range"
          min={1300}
          max={4000}
          step={100}
          value={rpm}
          onChange={(e) => setRpm(Number(e.target.value))}
          className="w-48 accent-sky-500"
        />
        <span className="w-20 text-sm tabular-nums text-slate-300">{rpm} RPM</span>
        <Button
          disabled={!connected || busy}
          variant={s.realtime ? 'primary' : 'default'}
          onClick={() => run(() => setSpeed({ data: { rpm } }))}
        >
          Set speed
        </Button>
        <Button disabled={!connected || busy} onClick={() => run(() => sendCommand({ data: { code: 0x05, values: {} } }))}>
          Wake
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </Card>
  )
}
