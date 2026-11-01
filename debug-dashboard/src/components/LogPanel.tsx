import type { LogEntry } from '#/lib/types'
import { Card } from './ui'

const KIND_STYLE: Record<LogEntry['kind'], string> = {
  tx: 'text-sky-400',
  rx: 'text-emerald-400',
  info: 'text-slate-400',
  error: 'text-red-400',
}

export function LogPanel({ log }: { log: LogEntry[] }) {
  return (
    <Card title="Log">
      <div className="max-h-80 overflow-y-auto font-mono text-xs">
        {log.length === 0 && <p className="text-slate-500">Nothing yet.</p>}
        {[...log].reverse().map((e) => (
          <div key={e.id} className="flex gap-3 py-0.5">
            <span className="shrink-0 text-slate-600">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={`w-10 shrink-0 uppercase ${KIND_STYLE[e.kind]}`}>{e.kind}</span>
            <span className="text-slate-200">{e.text}</span>
            {e.hex && <span className="ml-auto shrink-0 text-slate-500">{e.hex}</span>}
          </div>
        ))}
      </div>
    </Card>
  )
}
