import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCurve } from './curve'

const dir = mkdtempSync(join(tmpdir(), 'flydigi-fan-'))
process.env.XDG_CONFIG_HOME = dir
const { CONFIG_PATH, saveCurve, savedCurve } = await import('./config')

test('saves the curve under XDG_CONFIG_HOME and reads it back', () => {
  expect(CONFIG_PATH).toBe(join(dir, 'flydigi-fan', 'config.json'))
  expect(savedCurve()).toBeUndefined()
  saveCurve(parseCurve('70:3000, 50:1300'))
  expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))).toEqual({ curve: '50:1300,70:3000' })
  expect(savedCurve()).toEqual([
    [50, 1300],
    [70, 3000],
  ])
})

test('says which file is broken', () => {
  writeFileSync(CONFIG_PATH, '{"curve": "50:99"}')
  expect(() => savedCurve()).toThrow(CONFIG_PATH)
})
