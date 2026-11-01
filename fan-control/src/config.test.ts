import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCurve } from './curve'

const dir = mkdtempSync(join(tmpdir(), 'flydigi-fan-'))
process.env.XDG_CONFIG_HOME = dir
const { CONFIG_PATH, ensureConfig, saveCurve, saveGearLeds, savedCurve, savedGearLeds } = await import('./config')

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

test('keeps the gear LED setting next to the curve', () => {
  expect(savedGearLeds()).toBe(true) // default: the cooler's own default
  saveGearLeds(false)
  expect(savedGearLeds()).toBe(false)
  expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))).toEqual({ curve: '50:1300,70:3000', gearLeds: false })
})

test('ensureConfig only writes a missing file', () => {
  ensureConfig(parseCurve('60:2000'))
  expect(savedCurve()).toEqual([
    [50, 1300],
    [70, 3000],
  ])
  rmSync(CONFIG_PATH)
  ensureConfig(parseCurve('60:2000'))
  expect(savedCurve()).toEqual([[60, 2000]])
})

test('says which file is broken', () => {
  writeFileSync(CONFIG_PATH, '{"curve": "50:99"}')
  expect(() => savedCurve()).toThrow(CONFIG_PATH)
})
