// System tray icon, shared by every platform: a StatusNotifierItem over D-Bus on Linux
// (./sni), Shell_NotifyIcon on Windows (./win32). Elsewhere startTray() resolves to undefined
// and the program runs headless.

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

// Each process.platform check stays inline, next to its import(), so a build for one platform
// leaves the other's tray (and dbus-next) out. See detectPlatform() in ../sensors.
export async function startTray(log: (text: string) => void): Promise<Tray | undefined> {
  if (process.platform === 'linux') return (await import('./sni')).startSni(log)
  if (process.platform === 'win32') return (await import('./win32')).startWin32Tray(log)
  log('No tray icon on this platform yet')
  return undefined
}
