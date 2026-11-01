// Opens a file with the desktop's default app.
import { spawn } from 'node:child_process'

export function openPath(path: string, log: (text: string) => void) {
  const [cmd, ...args] = process.platform === 'win32' ? ['explorer.exe', path] : ['xdg-open', path]
  try {
    const child = spawn(cmd!, args, { stdio: 'ignore', detached: true })
    child.on('error', (err) => log(`Couldn't open ${path}: ${err.message}`))
    child.unref()
  } catch (err) {
    log(`Couldn't open ${path}: ${err instanceof Error ? err.message : err}`)
  }
}
