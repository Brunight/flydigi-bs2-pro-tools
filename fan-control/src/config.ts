// The curve saved with --save, in $XDG_CONFIG_HOME/flydigi-fan/config.json (~/.config by default).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatCurve, parseCurve, type Curve } from './curve'

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'flydigi-fan', 'config.json')

interface Config {
  curve?: string
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

export function saveCurve(curve: Curve) {
  const config = { ...read(), curve: formatCurve(curve) }
  mkdirSync(join(CONFIG_PATH, '..'), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}
