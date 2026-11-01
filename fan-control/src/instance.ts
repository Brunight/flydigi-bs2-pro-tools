// Only one instance at a time: two would fight over the cooler. A second start (a scheduled
// task run twice, a double click) finds the first one and exits. Restart releases the claim
// before starting the new process.
import { openSync, readFileSync, readlinkSync, unlinkSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Instance {
  release(): void
}

// A PID file, created exclusively. One left by a process that's gone, or by a different
// program that got its PID, is replaced.
export function claimPidFile(): Instance | undefined {
  const dir = process.env.XDG_RUNTIME_DIR || tmpdir()
  const path = join(dir, `flydigi-fan-${process.getuid?.() ?? 'user'}.pid`)
  const exe = (pid: number | 'self') => {
    try {
      return readlinkSync(`/proc/${pid}/exe`)
    } catch {
      return undefined
    }
  }
  const running = (pid: number) => {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    const theirs = exe(pid)
    return theirs === undefined || theirs === exe('self')
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return {
        release() {
          try {
            if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path)
          } catch {}
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let pid = NaN
    try {
      pid = Number(readFileSync(path, 'utf8'))
    } catch {}
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && running(pid)) return undefined
    try {
      unlinkSync(path)
    } catch {}
  }
  return undefined
}

// Keep each process.platform check inline, next to its import(); see ./sensors.
export async function claimInstance(): Promise<Instance | undefined> {
  if (process.platform === 'win32') return (await import('./win32/instance')).claim()
  else return claimPidFile()
}
