// Settings in $XDG_CONFIG_HOME/flydigi-fan/config.json (~/.config by default, %APPDATA% on
// Windows): the curve saved with --save, and the gear LED setting from the tray, which the
// cooler can't report back.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatCurve, parseCurve, type Curve } from './curve'

const configHome =
  process.env.XDG_CONFIG_HOME ||
  (process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config'))
export const CONFIG_PATH = join(configHome, 'flydigi-fan', 'config.json')

interface Config {
  curve?: string
  gearLeds?: boolean
}

function read(): Config {
  let text: string
  try {
    text = readFileSync(CONFIG_PATH, 'utf8')
  } catch {
    return {}
  }
  try {
    return JSON.parse(text) as Config
  } catch (err) {
    throw new Error(`${CONFIG_PATH} isn't valid JSON: ${err instanceof Error ? err.message : err}`)
  }
}

export function savedCurve(): Curve | undefined {
  const { curve } = read()
  if (curve === undefined) return undefined
  try {
    return parseCurve(curve)
  } catch (err) {
    throw new Error(`${CONFIG_PATH}: ${err instanceof Error ? err.message : err}`)
  }
}

// Merges into what's there, so saving one setting keeps the others.
function write(patch: Config) {
  const config = { ...read(), ...patch }
  mkdirSync(join(CONFIG_PATH, '..'), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

export function saveCurve(curve: Curve) {
  write({ curve: formatCurve(curve) })
}

export function savedGearLeds(): boolean {
  return read().gearLeds ?? true
}

export function saveGearLeds(on: boolean) {
  write({ gearLeds: on })
}

// So there's something to open: writes the curve in use if the file doesn't exist yet.
export function ensureConfig(curve: Curve) {
  if (!existsSync(CONFIG_PATH)) saveCurve(curve)
}
