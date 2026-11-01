// Every command in the cooler's firmware except 0xDF, which erases the firmware.
// Shared: the browser renders the inputs, the server validates and encodes them.
import { MAX_PAYLOAD, RAMP_NAMES, STANDBY_NAMES, SUPPLY_NAMES, hex, le16, parseHex, u16 } from './protocol'

export type Field =
  | { key: string; label: string; kind: 'select'; options: [string, number][]; initial: number }
  | { key: string; label: string; kind: 'number'; min: number; max: number; step?: number; initial: number }
  | { key: string; label: string; kind: 'hex'; maxBytes: number; initial: string }

export type Values = Record<string, string>

export type Group = 'Fan' | 'Lighting' | 'Settings' | 'Queries' | 'Raw lighting upload' | 'Danger zone'

export interface Command {
  code: number
  name: string
  group: Group
  description?: string
  fields?: Field[]
  encode?: (v: Values) => number[]
  decode?: (payload: Uint8Array) => string
  silent?: boolean // the firmware never replies to it
  danger?: string // shown in a confirmation before sending
}

const onOff: [string, number][] = [
  ['On', 1],
  ['Off', 0],
]
const gears: [string, number][] = [1, 2, 3, 4].map((g) => [`Gear ${g}`, g])
const ok = () => 'OK'
const byStatus = (meanings: Record<number, string>) => (p: Uint8Array) =>
  meanings[p[0]] ?? `Status 0x${hex([p[0]])}`
const mac = (p: Uint8Array) => hex([...p].reverse()).replaceAll(' ', ':')
const n = (v: Values, key: string) => Number(v[key])

export const COMMANDS: Command[] = [
  // Fan
  { code: 0x05, name: 'Wake', group: 'Fan', description: 'Starts a cooler that is asleep.', decode: ok },
  {
    code: 0x08,
    name: 'Select gear',
    group: 'Fan',
    description: 'Leaves custom-speed mode. Saved across power cycles.',
    fields: [{ key: 'gear', label: 'Gear', kind: 'select', options: gears, initial: 2 }],
    encode: (v) => [n(v, 'gear')],
    decode: byStatus({ 1: 'Applied', 5: 'Refused: power supply too weak for this gear' }),
  },
  {
    code: 0x23,
    name: 'Enter custom-speed mode',
    group: 'Fan',
    description: 'Required before "Set custom speed". Dropped when the last host disconnects.',
    decode: ok,
  },
  {
    code: 0x21,
    name: 'Set custom speed',
    group: 'Fan',
    fields: [{ key: 'rpm', label: 'RPM', kind: 'number', min: 1300, max: 4000, step: 100, initial: 2400 }],
    encode: (v) => le16(n(v, 'rpm')),
    decode: byStatus({ 1: 'Applied', 2: 'Refused: enter custom-speed mode first' }),
  },
  { code: 0x24, name: 'Exit custom-speed mode', group: 'Fan', description: 'Back to the selected gear.', decode: ok },
  {
    code: 0x26,
    name: 'Set gear speed',
    group: 'Fan',
    description: 'Saved to flash, and switches to that gear.',
    fields: [
      { key: 'gear', label: 'Gear', kind: 'select', options: gears, initial: 1 },
      { key: 'rpm', label: 'RPM', kind: 'number', min: 1300, max: 4000, step: 100, initial: 1700 },
    ],
    encode: (v) => [n(v, 'gear') - 1, ...le16(n(v, 'rpm'))],
    decode: byStatus({ 1: 'Stored', 0: 'Refused: gear out of range' }),
  },
  {
    code: 0x2a,
    name: 'Set ramp profile',
    group: 'Fan',
    description: 'How fast the fan changes speed.',
    fields: [{ key: 'profile', label: 'Profile', kind: 'select', options: RAMP_NAMES.map((r, i) => [r, i]), initial: 1 }],
    encode: (v) => [n(v, 'profile')],
    decode: ok,
  },

  // Lighting
  {
    code: 0x46,
    name: 'Light strip',
    group: 'Lighting',
    fields: [{ key: 'on', label: 'State', kind: 'select', options: onOff, initial: 1 }],
    encode: (v) => [n(v, 'on')],
    decode: ok,
  },
  {
    code: 0x48,
    name: 'Gear indicator LEDs',
    group: 'Lighting',
    fields: [{ key: 'on', label: 'State', kind: 'select', options: onOff, initial: 1 }],
    encode: (v) => [n(v, 'on')],
    decode: ok,
  },
  {
    code: 0x44,
    name: 'Select effect',
    group: 'Lighting',
    description: 'Presets 1–5 only show in custom-speed mode.',
    fields: [
      {
        key: 'mode',
        label: 'Effect',
        kind: 'select',
        options: [
          ['Uploaded effect', 0],
          ['Green breathing', 1],
          ['Yellow', 2],
          ['Red', 3],
          ['Static red', 4],
          ['Multicolour', 5],
        ],
        initial: 0,
      },
    ],
    encode: (v) => [n(v, 'mode')],
    decode: ok,
  },

  // Settings
  {
    code: 0x0c,
    name: 'Auto-start on power',
    group: 'Settings',
    fields: [
      {
        key: 'on',
        label: 'State',
        kind: 'select',
        options: [
          ['On', 1],
          ['Off', 2],
        ],
        initial: 1,
      },
    ],
    encode: (v) => [n(v, 'on')],
    decode: byStatus({ 1: 'Accepted', 0: 'Refused' }),
  },
  {
    code: 0x0d,
    name: 'Auto standby',
    group: 'Settings',
    description: 'Sleep when no host is connected. The server counts as a host while connected.',
    fields: [{ key: 'mode', label: 'Mode', kind: 'select', options: STANDBY_NAMES.slice(0, 3).map((s, i) => [s, i]), initial: 1 }],
    encode: (v) => [n(v, 'mode')],
    decode: ok,
  },
  { code: 0xee, name: 'Enable status stream', group: 'Settings', silent: true },
  {
    code: 0xed,
    name: 'Disable status stream',
    group: 'Settings',
    description: 'The status panel stops updating until re-enabled or the cooler reboots.',
    silent: true,
  },
  {
    code: 0x0a,
    name: 'Set scratch byte',
    group: 'Settings',
    description: 'A byte reserved for host apps. The cooler never reads it. Writes flash.',
    fields: [{ key: 'value', label: 'Value', kind: 'number', min: 0, max: 255, initial: 0 }],
    encode: (v) => [n(v, 'value')],
    decode: ok,
  },

  // Queries
  { code: 0x01, name: 'Firmware version', group: 'Queries', decode: (p) => [...p].join('.') },
  { code: 0x02, name: 'Power state', group: 'Queries', decode: byStatus({ 1: 'Awake', 2: 'Asleep' }) },
  { code: 0x07, name: 'Power supply', group: 'Queries', decode: (p) => SUPPLY_NAMES[p[0]] ?? hex(p) },
  { code: 0x22, name: 'Fan speed', group: 'Queries', decode: (p) => `${u16(p, 0)} RPM, target ${u16(p, 2)}` },
  {
    code: 0x25,
    name: 'Work mode',
    group: 'Queries',
    description: '"Gear 4" can also mean asleep.',
    decode: (p) => (p[0] === 5 ? 'Custom speed' : `Gear ${p[0]}`),
  },
  {
    code: 0x27,
    name: 'Gear speeds',
    group: 'Queries',
    decode: (p) => [0, 2, 4, 6].map((i) => u16(p, i)).join(' / ') + ' RPM',
  },
  { code: 0x29, name: 'Ramp profile', group: 'Queries', decode: (p) => RAMP_NAMES[p[0]] ?? hex(p) },
  { code: 0x45, name: 'Light strip', group: 'Queries', decode: (p) => (p[0] ? 'On' : 'Off') },
  { code: 0x09, name: 'Scratch byte', group: 'Queries', decode: (p) => `${p[0]}` },
  { code: 0x04, name: 'MAC address', group: 'Queries', decode: mac },
  { code: 0xf0, name: 'MAC address (alt)', group: 'Queries', decode: mac },
  { code: 0x0b, name: 'Device ID', group: 'Queries', decode: hex },

  // Raw lighting upload. The lighting card does all of this in one go.
  { code: 0x41, name: 'Begin upload', group: 'Raw lighting upload', decode: ok },
  {
    code: 0x47,
    name: 'Write light frame',
    group: 'Raw lighting upload',
    description: '10 bytes at offset index × 10 of the effect buffer.',
    fields: [
      { key: 'index', label: 'Index', kind: 'number', min: 0, max: 30, initial: 0 },
      { key: 'data', label: 'Data (hex)', kind: 'hex', maxBytes: 10, initial: '00 02 00 00 0F 64 FF 00 00 FF' },
    ],
    encode: (v) => [n(v, 'index'), ...parseHex(v.data)],
    decode: ok,
  },
  {
    code: 0x42,
    name: 'Upload block',
    group: 'Raw lighting upload',
    description: 'Appends bytes at the upload cursor. No reply means refused.',
    fields: [{ key: 'data', label: 'Data (hex)', kind: 'hex', maxBytes: 15, initial: '' }],
    encode: (v) => parseHex(v.data),
    decode: ok,
  },
  {
    code: 0x43,
    name: 'Commit and play',
    group: 'Raw lighting upload',
    description: 'Saves the buffer to flash and plays it.',
    encode: () => [1],
    decode: ok,
  },

  // Danger zone
  {
    code: 0x06,
    name: 'Factory reset',
    group: 'Danger zone',
    description: 'Wipes settings, lighting and gear speeds, then puts the cooler to sleep.',
    danger: 'Factory-reset the cooler? Settings, lighting and gear speeds are erased.',
    decode: ok,
  },
  {
    code: 0x03,
    name: 'Demo mode',
    group: 'Danger zone',
    description: 'Gear 1 with a white strip. Only a power cycle leaves it.',
    danger: 'Enter demo mode? Only unplugging the cooler gets it out.',
    decode: byStatus({ 1: 'Entered', 5: 'Already in demo mode' }),
  },
  {
    code: 0xf1,
    name: 'Disable checksum check',
    group: 'Danger zone',
    description: 'The cooler accepts corrupted frames until it reboots.',
    danger: 'Make the cooler accept corrupted frames until it reboots?',
    silent: true,
  },
  { code: 0xf2, name: 'Enable checksum check', group: 'Danger zone', description: 'The boot default.', silent: true },
]

export const GROUPS: Group[] = ['Fan', 'Lighting', 'Settings', 'Queries', 'Raw lighting upload', 'Danger zone']

export const commandByCode = new Map(COMMANDS.map((c) => [c.code, c]))

export function initialValues(cmd: Command): Values {
  return Object.fromEntries((cmd.fields ?? []).map((f) => [f.key, String(f.initial)]))
}

// Validates values against the field definitions before encoding. Throws on anything out of range.
export function encodeCommand(cmd: Command, values: Values): number[] {
  for (const f of cmd.fields ?? []) {
    const raw = values[f.key] ?? ''
    if (f.kind === 'hex') {
      if (parseHex(raw).length > f.maxBytes) throw new Error(`${f.label}: at most ${f.maxBytes} bytes`)
      continue
    }
    const v = Number(raw)
    if (!Number.isInteger(v)) throw new Error(`${f.label}: not a whole number`)
    if (f.kind === 'select' && !f.options.some(([, o]) => o === v)) throw new Error(`${f.label}: invalid option`)
    if (f.kind === 'number' && (v < f.min || v > f.max)) throw new Error(`${f.label}: must be ${f.min}–${f.max}`)
  }
  const payload = cmd.encode?.(values) ?? []
  if (payload.length > MAX_PAYLOAD) throw new Error(`Payload over ${MAX_PAYLOAD} bytes`)
  return payload
}
