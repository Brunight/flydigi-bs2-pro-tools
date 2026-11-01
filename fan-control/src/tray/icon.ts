// Draws the tray icon into an RGBA buffer, no image libraries: a fan cut out of a disc,
// inside a ring that fills clockwise and shifts green → amber → red.
// Coordinates are in a 64×64 design space. Plain pixels work for every platform's tray.
// The fan is light grey for dark panels, or dark grey for light ones.

type RGB = [number, number, number]
export type Panel = 'dark' | 'light'

const C = 32
const RING_R = 28.5
const RING_W = 5
const DISC_R = 21
const HUB_R = 4
const BLADES = 3
const FG: Record<Panel, RGB> = { dark: [232, 232, 232], light: [40, 40, 40] }
const SAMPLES = 4 // per axis, for anti-aliasing

const STOPS: [number, RGB][] = [
  [0, [63, 185, 80]],
  [0.55, [240, 180, 40]],
  [1, [240, 70, 60]],
]

function heat(p: number): RGB {
  const i = STOPS.findIndex(([at]) => at >= p)
  if (i <= 0) return STOPS[0]![1]
  const [a, ca] = STOPS[i - 1]!
  const [b, cb] = STOPS[i]!
  const t = (p - a) / (b - a)
  const mix = (k: 0 | 1 | 2) => Math.round(ca[k] + (cb[k] - ca[k]) * t)
  return [mix(0), mix(1), mix(2)]
}

// Blade outline from the mockup's two cubic curves, flattened to a polygon.
type Pt = [number, number]
function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps = 16) {
  const out: Pt[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ])
  }
  return out
}
const LEN = 17
const W = 8
const tip: Pt = [C + 3, C - LEN]
const BLADE: Pt[] = [
  [C, C],
  ...cubic([C, C], [C - W, C - LEN * 0.35], [C - W * 0.8, C - LEN], tip),
  ...cubic(tip, [C + W * 0.9, C - LEN * 0.95], [C + W * 0.6, C - LEN * 0.4], [C, C]),
]

function inPolygon(x: number, y: number, poly: Pt[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!
    const [xj, yj] = poly[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inBlade(x: number, y: number) {
  for (let i = 0; i < BLADES; i++) {
    // Rotate the point back instead of rotating the blade.
    const a = (-i * 2 * Math.PI) / BLADES
    const dx = x - C
    const dy = y - C
    if (inPolygon(C + dx * Math.cos(a) - dy * Math.sin(a), C + dx * Math.sin(a) + dy * Math.cos(a), BLADE)) return true
  }
  return false
}

// One sample: returns [r, g, b, a] with a in 0..1, painted back to front.
function sample(x: number, y: number, p: number, off: boolean, ring: RGB, fg: RGB): [number, number, number, number] {
  const dx = x - C
  const dy = y - C
  const d = Math.hypot(dx, dy)
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  const over = (c: RGB, alpha: number) => {
    const na = alpha + a * (1 - alpha)
    if (na === 0) return
    r = (c[0] * alpha + r * a * (1 - alpha)) / na
    g = (c[1] * alpha + g * a * (1 - alpha)) / na
    b = (c[2] * alpha + b * a * (1 - alpha)) / na
    a = na
  }

  // Ring: faint track, then the arc clockwise from 12 o'clock with round caps.
  if (Math.abs(d - RING_R) <= RING_W / 2) over(fg, 0.22)
  if (p > 0) {
    const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI) // 0 at top, clockwise
    const end = p * 2 * Math.PI
    let hit = Math.abs(d - RING_R) <= RING_W / 2 && angle <= end
    if (!hit && p < 1) {
      for (const at of [0, end]) {
        const cx = C + RING_R * Math.sin(at)
        const cy = C - RING_R * Math.cos(at)
        if (Math.hypot(x - cx, y - cy) <= RING_W / 2) hit = true
      }
    }
    if (hit) over(ring, 1)
  }

  // Disc with the blades cut out, hub kept.
  if (d <= DISC_R && (d <= HUB_R || !inBlade(x, y))) over(fg, off ? 0.4 : 1)
  return [r, g, b, a]
}

function renderPixel(out: Uint8Array, size: number, px: number, py: number, p: number, off: boolean, ring: RGB, fg: RGB) {
  const scale = 64 / size
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const s = sample((px + (sx + 0.5) / SAMPLES) * scale, (py + (sy + 0.5) / SAMPLES) * scale, p, off, ring, fg)
      r += s[0] * s[3]
      g += s[1] * s[3]
      b += s[2] * s[3]
      a += s[3]
    }
  }
  const i = (py * size + px) * 4
  if (a > 0) {
    out[i] = Math.round(r / a)
    out[i + 1] = Math.round(g / a)
    out[i + 2] = Math.round(b / a)
  }
  out[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255)
}

// Pixels that can touch the ring. Only these change with p; the fan never overlaps them.
function ringPixel(size: number, px: number, py: number) {
  const scale = 64 / size
  const d = Math.hypot((px + 0.5) * scale - C, (py + 0.5) * scale - C)
  const reach = scale * Math.SQRT1_2 // centre to corner of a pixel
  return Math.abs(d - RING_R) <= RING_W / 2 + reach
}

// The fan layer per size, drawn once: the blade cut-outs are the expensive part.
const fanCache = new Map<string, { base: Uint8Array; ring: number[] }>()

function fanLayer(size: number, off: boolean, panel: Panel) {
  const key = `${size}:${off}:${panel}`
  let layer = fanCache.get(key)
  if (!layer) {
    const base = new Uint8Array(size * size * 4)
    const ring: number[] = []
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        if (ringPixel(size, px, py)) ring.push(py * size + px)
        else renderPixel(base, size, px, py, 0, off, [0, 0, 0], FG[panel])
      }
    }
    layer = { base, ring }
    fanCache.set(key, layer)
  }
  return layer
}

// p: position on the fan curve, 0..1. off: below the curve, cooler off. panel: the tray background.
export function renderIcon(size: number, p: number, off: boolean, panel: Panel = 'dark'): Uint8Array {
  const { base, ring } = fanLayer(size, off, panel)
  const out = base.slice()
  const color = heat(p)
  for (const i of ring) renderPixel(out, size, i % size, Math.floor(i / size), p, off, color, FG[panel])
  return out
}
