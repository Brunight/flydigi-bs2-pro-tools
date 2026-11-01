// Flydigi BS2 / BS2 Pro / BS3 cooler protocol over the vendor GATT service 0xFFF0.
// Commands are written to 0xFFF2, replies and status frames arrive on 0xFFF1.
// Source: https://github.com/ElXreno/flydigictl docs/FIRMWARE.md (firmware disassembly).
//
// Frame: 5A A5 <cmd> <len> <payload...> <checksum>
//   len      = payload length + 2
//   checksum = (cmd + len + sum(payload)) & 0xFF

export const SERVICE_UUID = 0xfff0
export const WRITE_UUID = 0xfff2
export const NOTIFY_UUID = 0xfff1

export const CMD_STATUS = 0xef
// Erases the first flash sector and reboots into a bricked state. Never built, never sent.
const CMD_ERASE_FIRMWARE = 0xdf
// The vendor channel copies the declared length into a 64-byte slot unchecked, and the HID
// path rejects anything over 15, so nothing longer is ever sent.
export const MAX_PAYLOAD = 15

export function frame(cmd: number, payload: number[] = []): Uint8Array<ArrayBuffer> {
  if (cmd === CMD_ERASE_FIRMWARE) throw new Error('0xDF erases the firmware and is never sent')
  if (payload.length > MAX_PAYLOAD) throw new Error(`Payload over ${MAX_PAYLOAD} bytes`)
  const len = payload.length + 2
  const sum = payload.reduce((s, b) => s + b, cmd + len)
  return new Uint8Array([0x5a, 0xa5, cmd, len, ...payload, sum & 0xff])
}

export interface Frame {
  cmd: number
  payload: Uint8Array
  raw: Uint8Array
}

// 0xFFF1 is fed from a byte FIFO, so one notification can hold several frames or part of one.
export class FrameParser {
  private buf: number[] = []

  feed(data: Uint8Array): Frame[] {
    this.buf.push(...data)
    const out: Frame[] = []
    for (;;) {
      let i = 0
      while (i + 1 < this.buf.length && !(this.buf[i] === 0x5a && this.buf[i + 1] === 0xa5)) i++
      this.buf.splice(0, i)
      if (this.buf.length < 4) break
      const len = this.buf[3]
      if (len < 2 || len > 0x40) {
        this.buf.splice(0, 2) // not a real header, resync
        continue
      }
      const total = len + 3
      if (this.buf.length < total) break
      const raw = Uint8Array.from(this.buf.slice(0, total))
      const sum = raw.slice(2, total - 1).reduce((s, b) => s + b, 0) & 0xff
      if (sum !== raw[total - 1]) {
        this.buf.splice(0, 2)
        continue
      }
      out.push({ cmd: raw[2], payload: raw.slice(4, total - 1), raw })
      this.buf.splice(0, total)
    }
    if (this.buf.length > 256) this.buf = []
    return out
  }

  reset() {
    this.buf = []
  }
}

export const SUPPLY_NAMES = ['Detecting', '5 V (max 2700 RPM)', '9 V (max 3300 RPM)', 'PD 20 V (full speed)']
export const STANDBY_NAMES = ['Never', 'When disconnected', '60 s after disconnect', 'Never']
export const RAMP_NAMES = ['Gentle', 'Default', 'Fast', 'Fastest']

// Decoded 0xEF status payload, pushed every 500 ms.
export interface Status {
  asleep: boolean
  gear: number // effective gear 1..4, after the supply clamp
  bleLink: boolean
  usb: boolean
  supply: number
  demo: boolean
  realtime: boolean
  autoStart: boolean
  standby: number
  gearLeds: boolean
  strip: boolean
  rpm: number
  targetRpm: number
  ramp: number
  sequence: number
}

export function decodeStatus(p: Uint8Array): Status | undefined {
  if (p.length < 11) return undefined
  const [flags, mode, lights] = p
  return {
    asleep: !!(flags & 0x01),
    gear: ((flags >> 1) & 0x03) + 1,
    bleLink: !!(flags & 0x08),
    usb: !!(flags & 0x10),
    supply: (flags >> 5) & 0x03,
    demo: !!(flags & 0x80),
    realtime: !!(mode & 0x01),
    autoStart: !!(mode & 0x02),
    standby: (mode >> 2) & 0x03,
    gearLeds: !!(lights & 0x01),
    strip: !!(lights & 0x04),
    rpm: u16(p, 3),
    targetRpm: u16(p, 5),
    ramp: p[7],
    sequence: u16(p, 9),
  }
}

export function u16(p: Uint8Array, at: number) {
  return p[at] | (p[at + 1] << 8)
}

export function le16(v: number) {
  return [v & 0xff, (v >> 8) & 0xff]
}

export function hex(bytes: Uint8Array | number[]) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

export function parseHex(text: string): number[] {
  const clean = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (clean.length % 2) throw new Error('Hex needs an even number of digits')
  return clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []
}
