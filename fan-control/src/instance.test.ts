import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimPidFile } from './instance'

const dir = mkdtempSync(join(tmpdir(), 'flydigi-fan-'))
process.env.XDG_RUNTIME_DIR = dir
const pidPath = () => join(dir, readdirSync(dir)[0]!)

test('claims, refuses a second claim while the holder runs, and releases', async () => {
  const first = claimPidFile()
  expect(first).toBeDefined()
  const path = pidPath()

  // Another live process holding the file: refused.
  const other = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 10000)'])
  writeFileSync(path, `${other.pid}\n`)
  expect(claimPidFile()).toBeUndefined()
  other.kill()
  await other.exited

  // Its process is gone: the stale file is replaced.
  const second = claimPidFile()
  expect(second).toBeDefined()
  second!.release()
  expect(existsSync(path)).toBe(false)
  first!.release() // no longer its file: leaves nothing behind and doesn't throw
  rmSync(dir, { recursive: true })
})
