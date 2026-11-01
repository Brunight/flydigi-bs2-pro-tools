// System tray icon, shared by every platform. Only Linux (StatusNotifierItem over D-Bus) is
// implemented; on other platforms startTray() resolves to undefined and the program runs headless.
import { startSni } from './sni'

export interface TrayState {
  progress: number // position on the fan curve, 0..1
  off: boolean // the cooler is off or not connected: greyed-out fan
  tooltip: string
  forceOff: boolean
}

export interface TrayHandlers {
  onForceOff(on: boolean): void
  onQuit(): void
}

export interface Tray {
  update(state: TrayState): void
  close(): void
}

export async function startTray(handlers: TrayHandlers, log: (text: string) => void): Promise<Tray | undefined> {
  if (process.platform !== 'linux') {
    log('No tray icon on this platform yet')
    return undefined
  }
  return startSni(handlers, log)
}
