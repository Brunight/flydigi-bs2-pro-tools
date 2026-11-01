import { useState } from 'react'
import { EFFECTS, type LightingOptions } from '#/lib/lighting'
import { uploadLighting } from '#/server/functions'
import { Button, Card, inputClass, useAction } from './ui'

export function LightingCard({ connected }: { connected: boolean }) {
  const [opts, setOpts] = useState<LightingOptions>({
    effect: 'breathe',
    color: '#0078ff',
    speed: 15,
    brightness: 100,
    leds: 10,
  })
  const { busy, error, run } = useAction()
  const set = (patch: Partial<LightingOptions>) => setOpts({ ...opts, ...patch })

  return (
    <Card title="Lighting effect">
      <div className="flex flex-col gap-3 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            Effect
            <select className={inputClass} value={opts.effect} onChange={(e) => set({ effect: e.target.value as LightingOptions['effect'] })}>
              {EFFECTS.map(([label, v]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            Colour
            <input
              type="color"
              value={opts.color}
              disabled={opts.effect === 'rainbow'}
              onChange={(e) => set({ color: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-slate-700 bg-slate-800 disabled:opacity-30"
            />
          </label>
          <label className="flex items-center gap-2">
            Model
            <select className={inputClass} value={opts.leds} onChange={(e) => set({ leds: Number(e.target.value) })}>
              <option value={10}>BS2 / BS2 Pro (10 LEDs)</option>
              <option value={6}>BS3 / BS3 Pro (6 LEDs)</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2">
          <span className="w-20">Slowness</span>
          <input type="range" min={1} max={60} value={opts.speed} onChange={(e) => set({ speed: Number(e.target.value) })} className="w-48 accent-sky-500" />
          <span className="tabular-nums text-slate-300">{opts.speed}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-20">Brightness</span>
          <input
            type="range"
            min={0}
            max={100}
            value={opts.brightness}
            onChange={(e) => set({ brightness: Number(e.target.value) })}
            className="w-48 accent-sky-500"
          />
          <span className="tabular-nums text-slate-300">{opts.brightness}%</span>
        </label>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!connected || busy} onClick={() => run(() => uploadLighting({ data: opts }))}>
            {busy ? 'Uploading…' : 'Upload and play'}
          </Button>
          <span>Sends 0x41, the effect in 0x47 frames, then 0x43. Saved on the cooler.</span>
        </div>
        {error && <p className="text-red-400">{error}</p>}
      </div>
    </Card>
  )
}
