// System tray icon, shared by every platform. Only Linux (StatusNotifierItem over D-Bus) is
// implemented; on other platforms startTray() resolves to undefined and the program runs headless.
import { startSni } from './sni'

// Plain data, so each platform can turn it into its own menu (dbusmenu, a Windows HMENU…).
export type MenuItem =
  | { kind: 'action'; label: string; enabled?: boolean; onClick(): void }
  | { kind: 'check' | 'radio'; label: string; checked: boolean; enabled?: boolean; onClick(): void }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; items: MenuItem[] }

export interface TrayState {
  progress: number // ring fill, 0..1
  off: boolean // the cooler is off or not connected: greyed-out fan
  tooltip: string
  menu: MenuItem[]
}

export interface Tray {
  update(state: TrayState): void
  close(): void
}

export async function startTray(log: (text: string) => void): Promise<Tray | undefined> {
  if (process.platform !== 'linux') {
    log('No tray icon on this platform yet')
    return undefined
  }
  return startSni(log)
}
