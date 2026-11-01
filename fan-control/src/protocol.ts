// Flydigi BS2 / BS2 Pro / BS3 cooler protocol over the vendor GATT service 0xFFF0.
// Commands are written to 0xFFF2, replies arrive on 0xFFF1.
// The subset of debug-dashboard/src/lib/protocol.ts this daemon needs.
// Source: https://github.com/ElXreno/flydigictl docs/FIRMWARE.md (firmware disassembly).
//
// Frame: 5A A5 <cmd> <len> <payload...> <checksum>
//   len      = payload length + 2
//   checksum = (cmd + len + sum(payload)) & 0xFF

export const SERVICE_UUID = 0xfff0
export const WRITE_UUID = 0xfff2
export const NOTIFY_UUID = 0xfff1

export const CMD = {
  wake: 0x05,
  supply: 0x07,
  standby: 0x0d,
  selectGear: 0x08,
  setSpeed: 0x21,
  enterCustom: 0x23,
  gearSpeeds: 0x27,
  stripState: 0x45,
  strip: 0x46,
  gearLeds: 0x48,
} as const

export const MIN_RPM = 1300
export const MAX_RPM = 4000
// Highest RPM per supply level (0x07 reply). 0 is "still detecting", so no limit yet.
export const SUPPLY_MAX_RPM = [MAX_RPM, 2700, 3300, MAX_RPM]
export const SUPPLY_NAMES = ['detecting', '5 V', '9 V', 'PD 20 V']

// Erases the first flash sector and reboots into a bricked state. Never built, never sent.
const CMD_ERASE_FIRMWARE = 0xdf
// The vendor channel copies the declared length into a 64-byte slot unchecked.
const MAX_PAYLOAD = 15

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
      const raw = this.buf.slice(0, total)
      const sum = raw.slice(2, total - 1).reduce((s, b) => s + b, 0) & 0xff
      if (sum !== raw[total - 1]) {
        this.buf.splice(0, 2)
        continue
      }
      out.push({ cmd: raw[2], payload: Uint8Array.from(raw.slice(4, total - 1)) })
      this.buf.splice(0, total)
    }
    if (this.buf.length > 256) this.buf = []
    return out
  }

  reset() {
    this.buf = []
  }
}

export function u16(p: Uint8Array, at: number) {
  return p[at] | (p[at + 1] << 8)
}

export function le16(v: number) {
  return [v & 0xff, (v >> 8) & 0xff]
}
