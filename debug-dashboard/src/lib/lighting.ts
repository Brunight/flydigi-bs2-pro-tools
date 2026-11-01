// Builds the effect buffer uploaded with 0x41 → 0x47 × n → 0x43.
// Layout: [0] 0, [1] 2, [2] loop start, [3] frame count - 1, [4] speed (higher = slower),
// [5] brightness 0–100, then LED-major RGB: buf[6 + led * 30 + frame * 3], up to 10 frames.
// BS3 / BS3 Pro have 6 LEDs (firmware-verified). 10 for the BS2 Pro comes from
// zhugeshu/Flydigi-BS2-Pro-Controller and is not verified against its firmware.

export type Effect = 'solid' | 'breathe' | 'rainbow'
export const EFFECTS: [string, Effect][] = [
  ['Solid', 'solid'],
  ['Breathing', 'breathe'],
  ['Rainbow', 'rainbow'],
]

export interface LightingOptions {
  effect: Effect
  color: string // #rrggbb
  speed: number // 1–60
  brightness: number // 0–100
  leds: number // 6 or 10
}

type Rgb = [number, number, number]

const RAINBOW: Rgb[] = [
  [255, 0, 0],
  [255, 160, 0],
  [0, 255, 0],
  [0, 200, 255],
  [0, 0, 255],
  [200, 0, 255],
]

function parseColor(color: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(color)
  if (!m) throw new Error('Colour must be #rrggbb')
  const v = parseInt(m[1], 16)
  return [v >> 16, (v >> 8) & 0xff, v & 0xff]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)))

export function buildLightingBuffer(o: LightingOptions): number[] {
  const leds = o.leds === 6 ? 6 : 10
  const color = parseColor(o.color)
  // frames[led] = the colours that LED cycles through
  const frames: Rgb[][] = Array.from({ length: leds }, (_, led) => {
    if (o.effect === 'solid') return [color]
    if (o.effect === 'breathe') return [[0, 0, 0], color]
    return RAINBOW.map((_, f) => RAINBOW[(f + led) % RAINBOW.length])
  })
  const buf = new Array<number>(6 + leds * 30).fill(0)
  buf[1] = 2
  buf[3] = frames[0].length - 1
  buf[4] = clamp(o.speed, 1, 60)
  buf[5] = clamp(o.brightness, 0, 100)
  frames.forEach((list, led) =>
    list.forEach((rgb, f) => buf.splice(6 + led * 30 + f * 3, 3, ...rgb)),
  )
  return buf
}

// The upload as [cmd, payload] pairs: begin, one 0x47 per 10 bytes, commit.
export function lightingUpload(buf: number[]): [number, number[]][] {
  const out: [number, number[]][] = [[0x41, []]]
  for (let i = 0; i * 10 < buf.length; i++) {
    const chunk = buf.slice(i * 10, i * 10 + 10)
    out.push([0x47, [i, ...chunk, ...new Array(10 - chunk.length).fill(0)]])
  }
  out.push([0x43, [1]])
  return out
}
