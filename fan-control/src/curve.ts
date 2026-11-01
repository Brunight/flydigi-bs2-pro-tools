// Temperature → RPM curve: straight lines between points, flat past either end.
import { MAX_RPM, MIN_RPM } from './protocol'

export type Curve = [temp: number, rpm: number][]

export const DEFAULT_CURVE = '55:1300,65:2500,75:3200,85:4000'
const STEP = 100

// "40:1300,60:2200,80:4000"
export function parseCurve(text: string): Curve {
  const points = text.split(',').map((part) => {
    const [t, r] = part.split(':').map((s) => Number(s.trim()))
    if (!Number.isFinite(t) || !Number.isInteger(r)) throw new Error(`Bad curve point "${part}", expected temp:rpm`)
    if (r < MIN_RPM || r > MAX_RPM) throw new Error(`Curve RPM ${r} is outside ${MIN_RPM}–${MAX_RPM}`)
    return [t, r] as [number, number]
  })
  if (!points.length) throw new Error('Curve needs at least one point')
  points.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] === points[i - 1][0]) throw new Error(`Curve has ${points[i][0]}°C twice`)
  }
  return points
}

export function formatCurve(curve: Curve) {
  return curve.map(([t, r]) => `${t}:${r}`).join(',')
}

// Rounded to the nearest 100 RPM so sensor noise doesn't turn into a stream of writes.
export function rpmFor(curve: Curve, temp: number): number {
  const [first] = curve
  const last = curve[curve.length - 1]
  let rpm: number
  if (temp <= first[0]) rpm = first[1]
  else if (temp >= last[0]) rpm = last[1]
  else {
    const i = curve.findIndex(([t]) => t > temp)
    const [t0, r0] = curve[i - 1]
    const [t1, r1] = curve[i]
    rpm = r0 + ((temp - t0) / (t1 - t0)) * (r1 - r0)
  }
  return Math.min(MAX_RPM, Math.max(MIN_RPM, Math.round(rpm / STEP) * STEP))
}
