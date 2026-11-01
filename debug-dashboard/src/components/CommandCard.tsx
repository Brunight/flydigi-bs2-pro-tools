import { useState } from 'react'
import { COMMANDS, initialValues, type Command, type Field, type Group, type Values } from '#/lib/commands'
import { hex } from '#/lib/protocol'
import type { Reply } from '#/lib/types'
import { sendCommand } from '#/server/functions'
import { Button, Card, inputClass, useAction } from './ui'

export function CommandCard({ group, replies, connected }: { group: Group; replies: Record<number, Reply>; connected: boolean }) {
  const danger = group === 'Danger zone'
  return (
    <Card title={group} tone={danger ? 'danger' : undefined}>
      <div className="divide-y divide-slate-800">
        {COMMANDS.filter((c) => c.group === group).map((cmd) => (
          <CommandRow key={cmd.code} cmd={cmd} reply={replies[cmd.code]} connected={connected} />
        ))}
      </div>
    </Card>
  )
}

function CommandRow({ cmd, reply, connected }: { cmd: Command; reply?: Reply; connected: boolean }) {
  const [values, setValues] = useState<Values>(() => initialValues(cmd))
  const { busy, error, run } = useAction()

  function send() {
    if (cmd.danger && !window.confirm(cmd.danger)) return
    run(() => sendCommand({ data: { code: cmd.code, values, confirmed: !!cmd.danger } }))
  }

  return (
    <div className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-slate-100">
            {cmd.name} <code className="ml-1 text-xs text-slate-500">0x{hex([cmd.code])}</code>
          </div>
          {cmd.description && <p className="text-xs text-slate-400">{cmd.description}</p>}
        </div>
        <Button onClick={send} disabled={!connected || busy} variant={cmd.danger ? 'danger' : 'default'}>
          {cmd.fields ? 'Send' : cmd.group === 'Queries' ? 'Query' : 'Run'}
        </Button>
      </div>
      {cmd.fields && (
        <div className="flex flex-wrap items-center gap-3">
          {cmd.fields.map((f) => (
            <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
          ))}
        </div>
      )}
      {error ? (
        <p className="text-xs text-red-400">{error}</p>
      ) : cmd.silent ? (
        <p className="text-xs text-slate-500">The cooler doesn't reply to this one.</p>
      ) : (
        reply && (
          <p className="text-xs text-emerald-400" title={reply.hex}>
            → {reply.text} <span className="text-slate-500">· {new Date(reply.at).toLocaleTimeString()}</span>
          </p>
        )
      )}
    </div>
  )
}

function FieldInput({ field, value, onChange }: { field: Field; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400">
      {field.label}
      {field.kind === 'select' && (
        <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options.map(([label, v]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      )}
      {field.kind === 'number' && field.max - field.min > 255 && (
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-40 accent-sky-500"
        />
      )}
      {field.kind === 'number' && (
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputClass} w-20`}
        />
      )}
      {field.kind === 'hex' && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`up to ${field.maxBytes} bytes`}
          className={`${inputClass} w-64 font-mono`}
        />
      )}
    </label>
  )
}
