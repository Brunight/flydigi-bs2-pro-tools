// Linux tray icon: a StatusNotifierItem (KDE, and most other desktops; GNOME needs the
// AppIndicator extension) with a com.canonical.dbusmenu right-click menu, over the session bus.
import dbus from 'dbus-next'
import { renderIcon } from './icon'
import type { MenuItem, Tray, TrayState } from './index'

const { Interface, ACCESS_READ } = dbus.interface
const { Variant } = dbus

const ITEM_PATH = '/StatusNotifierItem'
const MENU_PATH = '/MenuBar'
const WATCHER = 'org.kde.StatusNotifierWatcher'
const SIZES = [16, 22, 24, 32, 48, 64]
const TITLE = 'Flydigi fan control'

type Pixmap = [number, number, Buffer]

// SNI wants ARGB32 in network byte order.
function pixmaps(progress: number, off: boolean): Pixmap[] {
  return SIZES.map((size) => {
    const rgba = renderIcon(size, progress, off)
    const out = Buffer.alloc(rgba.length)
    for (let i = 0; i < rgba.length; i += 4) {
      out[i] = rgba[i + 3]!
      out[i + 1] = rgba[i]!
      out[i + 2] = rgba[i + 1]!
      out[i + 3] = rgba[i + 2]!
    }
    return [size, size, out]
  })
}

const prop = (signature: string) => ({ signature, access: ACCESS_READ as typeof ACCESS_READ })

class Item extends Interface {
  icon: Pixmap[] = []
  tooltip = ''

  get Category() {
    return 'Hardware'
  }
  get Id() {
    return 'flydigi-fan'
  }
  get Title() {
    return TITLE
  }
  get Status() {
    return 'Active'
  }
  get IconName() {
    return ''
  }
  get IconPixmap() {
    return this.icon
  }
  get ToolTip() {
    return ['', [], TITLE, this.tooltip]
  }
  // Left click opens the menu too.
  get ItemIsMenu() {
    return true
  }
  get Menu() {
    return MENU_PATH
  }
  Activate() {}
  SecondaryActivate() {}
  ContextMenu() {}
  Scroll() {}
  NewIcon() {}
  NewToolTip() {}
}

Item.configureMembers({
  properties: {
    Category: prop('s'),
    Id: prop('s'),
    Title: prop('s'),
    Status: prop('s'),
    IconName: prop('s'),
    IconPixmap: prop('a(iiay)'),
    ToolTip: prop('(sa(iiay)ss)'),
    ItemIsMenu: prop('b'),
    Menu: prop('o'),
  },
  methods: {
    Activate: { inSignature: 'ii' },
    SecondaryActivate: { inSignature: 'ii' },
    ContextMenu: { inSignature: 'ii' },
    Scroll: { inSignature: 'is' },
  },
  signals: { NewIcon: { signature: '' }, NewToolTip: { signature: '' } },
})

type Props = Record<string, InstanceType<typeof Variant>>

interface MenuNode {
  item?: MenuItem // undefined for the root
  children: number[]
}

// com.canonical.dbusmenu over the MenuItem tree. Ids follow tree order, so they stay the same
// while the structure does.
class Menu extends Interface {
  revision = 1
  private nodes = new Map<number, MenuNode>([[0, { children: [] }]])
  private snapshot = ''
  private structure = ''

  constructor() {
    super('com.canonical.dbusmenu')
  }

  setItems(items: MenuItem[]) {
    const nodes = new Map<number, MenuNode>()
    let next = 1
    const add = (list: MenuItem[]): number[] =>
      list.map((item) => {
        const id = next++
        nodes.set(id, { item, children: item.kind === 'submenu' ? add(item.items) : [] })
        return id
      })
    nodes.set(0, { children: add(items) })
    // Always take the new nodes (fresh click handlers), but only tell the tray when
    // something it shows changed. LayoutUpdated covers the tree; Plasma keeps its cached
    // check and enabled states unless ItemsPropertiesUpdated says otherwise.
    this.nodes = nodes
    const snapshot = JSON.stringify(items)
    if (snapshot === this.snapshot) return
    this.snapshot = snapshot
    const structure = JSON.stringify(items, (key, value) =>
      key === 'label' || key === 'checked' || key === 'enabled' ? undefined : value,
    )
    if (structure !== this.structure) {
      this.structure = structure
      this.revision++
      this.LayoutUpdated()
    }
    this.ItemsPropertiesUpdated()
  }

  private props(id: number): Props {
    const item = this.nodes.get(id)?.item
    if (!item) return { 'children-display': new Variant('s', 'submenu') }
    if (item.kind === 'separator') return { type: new Variant('s', 'separator') }
    const props: Props = { label: new Variant('s', item.label) }
    if (item.kind === 'submenu') props['children-display'] = new Variant('s', 'submenu')
    else props.enabled = new Variant('b', item.enabled ?? true)
    if (item.kind === 'check' || item.kind === 'radio') {
      props['toggle-type'] = new Variant('s', item.kind === 'check' ? 'checkmark' : 'radio')
      props['toggle-state'] = new Variant('i', item.checked ? 1 : 0)
    }
    return props
  }

  private node(id: number): [number, Props, InstanceType<typeof Variant>[]] {
    const children = this.nodes.get(id)?.children ?? []
    return [id, this.props(id), children.map((c) => new Variant('(ia{sv}av)', this.node(c)))]
  }

  get Version() {
    return 3
  }
  get TextDirection() {
    return 'ltr'
  }
  get Status() {
    return 'normal'
  }
  get IconThemePath() {
    return []
  }
  GetLayout(parentId: number) {
    return [this.revision, this.node(parentId)]
  }
  GetGroupProperties(ids: number[]) {
    return (ids.length ? ids : [...this.nodes.keys()]).map((id) => [id, this.props(id)])
  }
  GetProperty(id: number, name: string) {
    return this.props(id)[name] ?? new Variant('s', '')
  }
  Event(id: number, eventId: string) {
    const item = this.nodes.get(id)?.item
    if (eventId !== 'clicked' || !item || item.kind === 'separator' || item.kind === 'submenu') return
    if (item.enabled ?? true) item.onClick()
    // Plasma flips a check or radio item itself when it's clicked, and doesn't group radios.
    // Send every item's real state back, even if the click changed nothing.
    this.ItemsPropertiesUpdated()
  }
  EventGroup(events: [number, string, unknown, number][]) {
    for (const [id, eventId] of events) this.Event(id, eventId)
    return []
  }
  AboutToShow() {
    return false
  }
  AboutToShowGroup() {
    return [[], []]
  }
  LayoutUpdated() {
    return [this.revision, 0]
  }
  ItemsPropertiesUpdated() {
    const updated = [...this.nodes.keys()].filter((id) => id !== 0).map((id) => [id, this.props(id)])
    return [updated, []]
  }
}

Menu.configureMembers({
  properties: {
    Version: prop('u'),
    TextDirection: prop('s'),
    Status: prop('s'),
    IconThemePath: prop('as'),
  },
  methods: {
    GetLayout: { inSignature: 'iias', outSignature: 'u(ia{sv}av)' },
    GetGroupProperties: { inSignature: 'aias', outSignature: 'a(ia{sv})' },
    GetProperty: { inSignature: 'is', outSignature: 'v' },
    Event: { inSignature: 'isvu' },
    EventGroup: { inSignature: 'a(isvu)', outSignature: 'ai' },
    AboutToShow: { inSignature: 'i', outSignature: 'b' },
    AboutToShowGroup: { inSignature: 'ai', outSignature: 'aiai' },
  },
  signals: {
    LayoutUpdated: { signature: 'ui' },
    ItemsPropertiesUpdated: { signature: 'a(ia{sv})a(ias)' },
  },
})

export async function startSni(log: (text: string) => void): Promise<Tray | undefined> {
  let bus: ReturnType<typeof dbus.sessionBus>
  try {
    bus = dbus.sessionBus()
  } catch (err) {
    log(`No tray icon: ${err instanceof Error ? err.message : err}`)
    return undefined
  }
  bus.on('error', (err) => log(`Tray: ${err instanceof Error ? err.message : err}`))

  const name = `org.freedesktop.StatusNotifierItem-${process.pid}-1`
  const item = new Item('org.kde.StatusNotifierItem')
  const menu = new Menu()
  item.icon = pixmaps(0, true)

  const register = async () => {
    const watcher = await bus.getProxyObject(WATCHER, '/StatusNotifierWatcher')
    await watcher.getInterface(WATCHER).RegisterStatusNotifierItem!(name)
  }
  try {
    bus.export(ITEM_PATH, item)
    bus.export(MENU_PATH, menu)
    await bus.requestName(name, 0)
    await register()
  } catch (err) {
    log(`No tray icon: no system tray found (${err instanceof Error ? err.message : err})`)
    bus.disconnect()
    return undefined
  }

  // The tray forgets every item when the panel restarts, so register again when it's back.
  try {
    const busObject = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus')
    busObject.getInterface('org.freedesktop.DBus').on('NameOwnerChanged', (owner: string, _old: string, now: string) => {
      if (owner === WATCHER && now) register().catch(() => {})
    })
  } catch {}

  let iconKey = ''
  // Temperatures hover around a few values, so keep recent icons instead of redrawing them.
  const recent = new Map<string, Pixmap[]>()
  return {
    update(state: TrayState) {
      // Redraw only when the picture changes; 1 % steps are finer than 64 px can show.
      const progress = state.off ? 0 : Math.min(1, Math.max(0, state.progress))
      const key = `${state.off}:${Math.round(progress * 100)}`
      if (key !== iconKey) {
        iconKey = key
        let icon = recent.get(key)
        if (!icon) {
          icon = pixmaps(progress, state.off)
          if (recent.size >= 32) recent.delete(recent.keys().next().value!)
          recent.set(key, icon)
        }
        item.icon = icon
        item.NewIcon()
      }
      if (state.tooltip !== item.tooltip) {
        item.tooltip = state.tooltip
        item.NewToolTip()
      }
      menu.setItems(state.menu)
    },
    close() {
      bus.disconnect()
    },
  }
}
