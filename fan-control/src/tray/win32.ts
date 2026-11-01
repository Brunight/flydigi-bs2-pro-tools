// Windows tray icon: Shell_NotifyIconW on a hidden window, through bun:ffi, with a popup menu
// on left or right click. The JS thread runs Bun's event loop, not GetMessage, so the window's
// messages are pumped from a timer; while the menu is open, Windows runs its own loop.
import { FFIType, JSCallback, dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi'
import { wide } from '../win32/text'
import { renderIcon, type Panel } from './icon'
import type { MenuItem, Tray, TrayState } from './index'

const { i32, u32, i64, u16, ptr: P } = FFIType

const user32 = dlopen('user32.dll', {
  RegisterClassExW: { args: [P], returns: u16 },
  CreateWindowExW: { args: [u32, P, P, u32, i32, i32, i32, i32, P, P, P, P], returns: P },
  DestroyWindow: { args: [P], returns: i32 },
  DefWindowProcW: { args: [P, u32, i64, i64], returns: i64 },
  PeekMessageW: { args: [P, P, u32, u32, u32], returns: i32 },
  TranslateMessage: { args: [P], returns: i32 },
  DispatchMessageW: { args: [P], returns: i64 },
  PostMessageW: { args: [P, u32, i64, i64], returns: i32 },
  RegisterWindowMessageW: { args: [P], returns: u32 },
  ChangeWindowMessageFilterEx: { args: [P, u32, u32, P], returns: i32 },
  SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
  GetDpiForWindow: { args: [P], returns: u32 },
  GetSystemMetricsForDpi: { args: [i32, u32], returns: i32 },
  CreatePopupMenu: { args: [], returns: P },
  AppendMenuW: { args: [P, u32, P, P], returns: i32 },
  CheckMenuRadioItem: { args: [P, u32, u32, u32, u32], returns: i32 },
  TrackPopupMenuEx: { args: [P, u32, i32, i32, P, P], returns: i32 },
  DestroyMenu: { args: [P], returns: i32 },
  SetForegroundWindow: { args: [P], returns: i32 },
  GetCursorPos: { args: [P], returns: i32 },
  CreateIconIndirect: { args: [P], returns: P },
  DestroyIcon: { args: [P], returns: i32 },
}).symbols
const gdi32 = dlopen('gdi32.dll', {
  CreateDIBSection: { args: [P, P, u32, P, P, u32], returns: P },
  CreateBitmap: { args: [i32, i32, u32, u32, P], returns: P },
  DeleteObject: { args: [P], returns: i32 },
}).symbols
const shell32 = dlopen('shell32.dll', {
  Shell_NotifyIconW: { args: [u32, P], returns: i32 },
}).symbols
const kernel32 = dlopen('kernel32.dll', {
  GetModuleHandleW: { args: [P], returns: P },
}).symbols
const advapi32 = dlopen('advapi32.dll', {
  RegGetValueW: { args: [i64, P, P, u32, P, P, P], returns: i32 },
}).symbols

const TITLE = 'Flydigi fan control'
const PUMP_MS = 100
const ICON_CACHE = 32

const WM_NULL = 0x0000
const WM_SETTINGCHANGE = 0x001a
const WM_CONTEXTMENU = 0x007b
const WM_APP = 0x8000
const WM_TRAY = WM_APP + 1
const NIN_SELECT = 0x0400
const NIN_KEYSELECT = 0x0401
const PM_REMOVE = 1
const MSGFLT_ALLOW = 1
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4n
const SM_CXSMICON = 49

const NIM_ADD = 0
const NIM_MODIFY = 1
const NIM_DELETE = 2
const NIM_SETVERSION = 4
const NIF_MESSAGE = 0x01
const NIF_ICON = 0x02
const NIF_TIP = 0x04
const NIF_SHOWTIP = 0x80
const NOTIFYICON_VERSION_4 = 4

const MF_STRING = 0x0000
const MF_GRAYED = 0x0001
const MF_CHECKED = 0x0008
const MF_POPUP = 0x0010
const MF_SEPARATOR = 0x0800
const MF_BYCOMMAND = 0x0000
const TPM_RIGHTBUTTON = 0x0002
const TPM_BOTTOMALIGN = 0x0020
const TPM_NONOTIFY = 0x0080
const TPM_RETURNCMD = 0x0100

const HKEY_CURRENT_USER = -2147483647n // (HKEY)(LONG)0x80000001, sign-extended
const RRF_RT_REG_DWORD = 0x10

// Pointers come back as a bigint when they don't fit in a double; both can be passed back.
type Handle = Pointer | bigint
const addr = (p: Handle | number | null) => BigInt(p ?? 0)

// The taskbar's theme, for the fan's colour. Dark when unknown.
function panelTheme(): Panel {
  const value = new Uint32Array(1)
  const size = new Uint32Array([4])
  const status = advapi32.RegGetValueW(
    HKEY_CURRENT_USER,
    ptr(wide('Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize')),
    ptr(wide('SystemUsesLightTheme')),
    RRF_RT_REG_DWORD,
    null,
    ptr(value),
    ptr(size),
  )
  return status === 0 && value[0] === 1 ? 'light' : 'dark'
}

// A 32-bit DIB with alpha; the mask is unused but has to exist.
function createIcon(size: number, progress: number, off: boolean, panel: Panel): Handle {
  const header = Buffer.alloc(40) // BITMAPINFOHEADER, top-down
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(-size, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const bits = new BigUint64Array(1)
  const color = gdi32.CreateDIBSection(null, ptr(header), 0, ptr(bits), null, 0)
  if (!color) throw new Error('CreateDIBSection failed')
  const rgba = renderIcon(size, progress, off, panel)
  const bgra = new Uint8Array(toArrayBuffer(Number(bits[0]) as Pointer, 0, rgba.length))
  for (let i = 0; i < rgba.length; i += 4) {
    bgra[i] = rgba[i + 2]!
    bgra[i + 1] = rgba[i + 1]!
    bgra[i + 2] = rgba[i]!
    bgra[i + 3] = rgba[i + 3]!
  }
  const mask = gdi32.CreateBitmap(size, size, 1, 1, ptr(Buffer.alloc(Math.ceil(size / 16) * 2 * size)))
  const info = Buffer.alloc(32) // ICONINFO
  info.writeInt32LE(1, 0) // fIcon
  info.writeBigUInt64LE(addr(mask), 16)
  info.writeBigUInt64LE(addr(color), 24)
  const icon = user32.CreateIconIndirect(ptr(info))
  gdi32.DeleteObject(color)
  if (mask) gdi32.DeleteObject(mask)
  if (!icon) throw new Error('CreateIconIndirect failed')
  return icon
}

// "&" marks a mnemonic in menu labels.
const menuLabel = (text: string) => ptr(wide(text.replace(/&/g, '&&')))

export async function startWin32Tray(log: (text: string) => void): Promise<Tray | undefined> {
  // Before the window exists, so it and the icon size follow the monitor's real DPI.
  user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)

  const instance = kernel32.GetModuleHandleW(null)
  const className = wide('FlydigiFanTray')
  const taskbarCreated = user32.RegisterWindowMessageW(ptr(wide('TaskbarCreated')))
  let state: TrayState | undefined
  let menuOpen = false
  let closed = false

  const wndProc = new JSCallback(
    (hwnd: Pointer, msg: number, wParam: bigint, lParam: bigint): bigint => {
      if (msg === WM_TRAY) {
        const event = Number(BigInt(lParam) & 0xffffn)
        // Left click opens the menu too, like on Linux.
        if (event === NIN_SELECT || event === NIN_KEYSELECT || event === WM_CONTEXTMENU) setTimeout(showMenu, 0)
        return 0n
      }
      // Explorer restarted: the taskbar forgot every icon.
      if (msg === taskbarCreated && taskbarCreated) {
        added = false
        setTimeout(show, 0)
        return 0n
      }
      if (msg === WM_SETTINGCHANGE) setTimeout(checkTheme, 0)
      return BigInt(user32.DefWindowProcW(hwnd, msg, wParam, lParam))
    },
    { args: [P, u32, i64, i64], returns: i64 },
  )

  const wc = Buffer.alloc(80) // WNDCLASSEXW
  wc.writeUInt32LE(80, 0)
  wc.writeBigUInt64LE(addr(wndProc.ptr), 8)
  wc.writeBigUInt64LE(addr(instance), 24)
  wc.writeBigUInt64LE(addr(ptr(className)), 64)
  user32.RegisterClassExW(ptr(wc)) // fails harmlessly if a restart in this process registered it
  // A hidden top-level window rather than a message-only one: those miss TaskbarCreated.
  const hwnd = user32.CreateWindowExW(0, ptr(className), ptr(wide(TITLE)), 0, 0, 0, 0, 0, null, null, instance, null)
  if (!hwnd) {
    wndProc.close()
    log('No tray icon: CreateWindowExW failed')
    return undefined
  }
  // Running elevated, messages from Explorer (a lower integrity level) are dropped unless allowed.
  user32.ChangeWindowMessageFilterEx(hwnd, WM_TRAY, MSGFLT_ALLOW, null)
  if (taskbarCreated) user32.ChangeWindowMessageFilterEx(hwnd, taskbarCreated, MSGFLT_ALLOW, null)

  const msg = new Uint8Array(48) // MSG
  const pump = setInterval(() => {
    while (user32.PeekMessageW(ptr(msg), null, 0, 0, PM_REMOVE)) {
      user32.TranslateMessage(ptr(msg))
      user32.DispatchMessageW(ptr(msg))
    }
  }, PUMP_MS)

  // NOTIFYICONDATAW (x64), filled in by show().
  const nid = Buffer.alloc(976)
  nid.writeUInt32LE(976, 0)
  nid.writeBigUInt64LE(addr(hwnd), 8)
  nid.writeUInt32LE(1, 16) // uID
  nid.writeUInt32LE(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP, 20)
  nid.writeUInt32LE(WM_TRAY, 24)
  nid.writeUInt32LE(NOTIFYICON_VERSION_4, 816)

  let panel = panelTheme()
  const iconSize = () => user32.GetSystemMetricsForDpi(SM_CXSMICON, user32.GetDpiForWindow(hwnd) || 96) || 16
  // Temperatures hover around a few values, so keep recent icons instead of redrawing them.
  // Most recently used last, so the one on screen is never the one dropped.
  const icons = new Map<string, Handle>()
  const iconFor = (progress: number, off: boolean) => {
    const size = iconSize()
    const key = `${size}:${panel}:${off}:${Math.round(progress * 100)}`
    let icon = icons.get(key)
    if (icon) icons.delete(key)
    else {
      icon = createIcon(size, progress, off, panel)
      if (icons.size >= ICON_CACHE) {
        const [oldKey, old] = icons.entries().next().value!
        icons.delete(oldKey)
        user32.DestroyIcon(old)
      }
    }
    icons.set(key, icon)
    return icon
  }

  let added = false
  let iconKey = ''
  function show() {
    if (closed) return
    const progress = !state || state.off ? 0 : Math.min(1, Math.max(0, state.progress))
    nid.writeBigUInt64LE(addr(iconFor(progress, state?.off ?? true)), 32)
    nid.fill(0, 40, 40 + 256)
    nid.write(`${TITLE}\n${state?.tooltip ?? ''}`.slice(0, 127), 40, 'utf16le')
    if (added) {
      if (!shell32.Shell_NotifyIconW(NIM_MODIFY, ptr(nid))) added = false
    }
    if (!added && shell32.Shell_NotifyIconW(NIM_ADD, ptr(nid))) {
      shell32.Shell_NotifyIconW(NIM_SETVERSION, ptr(nid))
      added = true
    }
  }

  function checkTheme() {
    const next = panelTheme()
    if (next === panel) return
    panel = next
    iconKey = ''
    show()
  }

  function showMenu() {
    if (menuOpen || closed || !state) return
    menuOpen = true
    const actions: (() => void)[] = []
    const build = (items: MenuItem[]): Handle => {
      const menu = user32.CreatePopupMenu()!
      for (const item of items) {
        if (item.kind === 'separator') user32.AppendMenuW(menu, MF_SEPARATOR, null, null)
        else if (item.kind === 'submenu') user32.AppendMenuW(menu, MF_POPUP, build(item.items), menuLabel(item.label))
        else {
          const id = actions.push(item.onClick)
          let flags = MF_STRING
          if (item.enabled === false) flags |= MF_GRAYED
          if (item.kind !== 'action' && item.checked) flags |= MF_CHECKED
          user32.AppendMenuW(menu, flags, id as Pointer, menuLabel(item.label))
          // A bullet instead of a tick.
          if (item.kind === 'radio' && item.checked) user32.CheckMenuRadioItem(menu, id, id, id, MF_BYCOMMAND)
        }
      }
      return menu
    }
    const menu = build(state.menu)
    const cursor = new Int32Array(2)
    user32.GetCursorPos(ptr(cursor))
    // Without this the menu doesn't close when clicking elsewhere (KB135788).
    user32.SetForegroundWindow(hwnd)
    const flags = TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN
    const chosen = user32.TrackPopupMenuEx(menu, flags, cursor[0]!, cursor[1]!, hwnd, null)
    user32.PostMessageW(hwnd, WM_NULL, 0n, 0n)
    user32.DestroyMenu(menu) // and its submenus
    menuOpen = false
    if (chosen > 0) actions[chosen - 1]?.()
  }

  show()
  if (!added) log('Tray: no taskbar yet, the icon appears once there is one')

  return {
    update(next: TrayState) {
      state = next
      const progress = next.off ? 0 : Math.min(1, Math.max(0, next.progress))
      const key = `${next.off}:${Math.round(progress * 100)}:${next.tooltip}`
      if (key === iconKey && added) return
      iconKey = key
      show()
    },
    close() {
      if (closed) return
      closed = true
      clearInterval(pump)
      if (added) shell32.Shell_NotifyIconW(NIM_DELETE, ptr(nid))
      user32.DestroyWindow(hwnd)
      for (const icon of icons.values()) user32.DestroyIcon(icon)
      icons.clear()
      wndProc.close()
    },
  }
}
