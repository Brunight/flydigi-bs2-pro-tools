// Owns the Bluetooth link to the cooler. One per server process.
import { Bluetooth } from 'webbluetooth'
import { commandByCode, encodeCommand, type Values } from '#/lib/commands'
import { lightingUpload } from '#/lib/lighting'
import {
  CMD_STATUS,
  FrameParser,
  NOTIFY_UUID,
  SERVICE_UUID,
  WRITE_UUID,
  decodeStatus,
  frame,
  hex,
  u16,
  type Status,
} from '#/lib/protocol'
import type { CoolerState, LogEntry } from '#/lib/types'

const LOG_LIMIT = 150
// The firmware takes one frame per 5 ms and drops the rest silently, so leave headroom.
const WRITE_GAP_MS = 30
const SCAN_SECONDS = 10
// The BS2 Pro only pushes 0xEF status frames over HID, not this channel, so ask instead.
const POLL_MS = 1000
const POLLED = [0x22, 0x25, 0x02, 0x45]
// Matches "FlyDigi BS2PRO" and similar. Set COOLER_NAME to pick a specific device.
const NAME_MATCH = process.env.COOLER_NAME
  ? (name: string) => name === process.env.COOLER_NAME
  : (name: string) => /flydigi|^bs[123]/i.test(name)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

class Cooler {
  private state: CoolerState = { connection: 'disconnected', replies: {}, log: [] }
  private device?: BluetoothDevice
  private writer?: BluetoothRemoteGATTCharacteristic
  private parser = new FrameParser()
  private queue: Promise<unknown> = Promise.resolve()
  private pollTimer?: ReturnType<typeof setInterval>
  // Replies still owed to the poller, per command, so they stay out of the log.
  private quiet = new Map<number, number>()
  private nextLogId = 1

  snapshot(): CoolerState {
    return this.state
  }

  async connect() {
    if (this.state.connection !== 'disconnected') return
    this.update({ connection: 'scanning', error: undefined })
    this.log('info', 'Scanning for the cooler…')
    let device: BluetoothDevice | undefined
    try {
      const bluetooth = new Bluetooth({
        scanTime: SCAN_SECONDS,
        deviceFound: (d) => NAME_MATCH(d.name ?? ''),
      })
      device = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE_UUID] })
      this.update({ connection: 'connecting', deviceName: device.name })
      this.log('info', `Found ${device.name}, connecting…`)

      const server = await device.gatt!.connect()
      const service = await server.getPrimaryService(SERVICE_UUID)
      const writer = await service.getCharacteristic(WRITE_UUID)
      const notifier = await service.getCharacteristic(NOTIFY_UUID)
      notifier.addEventListener('characteristicvaluechanged', () => {
        const v = notifier.value
        if (v) this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
      })
      device.addEventListener('gattserverdisconnected', () => this.onDisconnected())
      await notifier.startNotifications()

      this.device = device
      this.writer = writer
      this.parser.reset()
      this.quiet.clear()
      this.update({ connection: 'connected', status: {} })
      this.log('info', `Connected to ${device.name}`)

      this.query(0x07) // supply level, decided once per power-up
      this.query(0x29)
      this.pollTimer = setInterval(() => POLLED.forEach((c) => this.query(c)), POLL_MS)
    } catch (err) {
      // Don't leave a half-open link behind; BlueZ would keep it and the next try fails too.
      device?.gatt?.disconnect()
      const hint = /timed out/i.test(message(err))
        ? ' If this keeps happening, pair the cooler in your system Bluetooth settings first.'
        : ''
      this.update({ connection: 'disconnected', error: message(err) + hint })
      this.log('error', `Connect failed: ${message(err)}`)
    }
  }

  async disconnect() {
    this.device?.gatt?.disconnect()
    this.onDisconnected()
  }

  // The firmware has no sleep command. It sleeps when its last host goes away while auto
  // standby is on, so: standby to "instant", then drop the link. A USB host or another
  // Bluetooth connection keeps it awake.
  async turnOff() {
    await this.send(0x0d, { mode: '1' })
    await sleep(300) // let the setting land before the link goes
    await this.disconnect()
    this.log('info', 'Turned off. The cooler sleeps unless another device is connected to it.')
  }

  // Connecting wakes it when standby is on; 0x05 covers the case where it isn't.
  async turnOn() {
    await this.connect()
    if (this.state.connection === 'connected') await this.send(0x05, {})
  }

  async send(code: number, values: Values, confirmed = false) {
    const cmd = commandByCode.get(code)
    if (!cmd) throw new Error(`Unknown command 0x${hex([code])}`)
    if (cmd.danger && !confirmed) throw new Error(`${cmd.name} needs confirmation`)
    const payload = encodeCommand(cmd, values)
    await this.write(code, payload, cmd.name)
    this.applySent(code, payload)
  }

  async uploadLighting(buffer: number[]) {
    for (const [code, payload] of lightingUpload(buffer)) {
      await this.write(code, payload, commandByCode.get(code)?.name ?? 'Lighting')
    }
    this.log('info', `Uploaded ${buffer.length}-byte lighting effect`)
  }

  private query(code: number) {
    if (this.state.connection !== 'connected') return
    this.quiet.set(code, (this.quiet.get(code) ?? 0) + 1)
    this.write(code, [], '', true).catch(() => this.quiet.set(code, Math.max(0, (this.quiet.get(code) ?? 1) - 1)))
  }

  private write(code: number, payload: number[], name: string, silent = false) {
    const bytes = frame(code, payload)
    const run = this.queue.then(async () => {
      const writer = this.writer
      if (!writer || this.state.connection !== 'connected') throw new Error('Not connected')
      if (!silent) this.log('tx', name, hex(bytes))
      if (writer.properties.write) await writer.writeValueWithResponse(bytes)
      else await writer.writeValueWithoutResponse(bytes)
      await sleep(WRITE_GAP_MS)
    })
    // Keep the queue alive after a failure; the caller still gets the error.
    this.queue = run.catch((err) => {
      if (!silent) this.log('error', `${name}: ${message(err)}`)
    })
    return run
  }

  private onData(data: Uint8Array) {
    for (const f of this.parser.feed(data)) {
      if (f.cmd === CMD_STATUS) {
        const status = decodeStatus(f.payload)
        if (status) this.mergeStatus(status)
        continue
      }
      this.applyReply(f.cmd, f.payload)
      const cmd = commandByCode.get(f.cmd)
      const text = cmd?.decode ? cmd.decode(f.payload) : hex(f.payload)
      this.update({ replies: { ...this.state.replies, [f.cmd]: { text, hex: hex(f.payload), at: Date.now() } } })

      const owed = this.quiet.get(f.cmd) ?? 0
      if (owed > 0) this.quiet.set(f.cmd, owed - 1)
      else this.log('rx', `${cmd?.name ?? `0x${hex([f.cmd])}`}: ${text}`, hex(f.raw))
    }
  }

  // Query replies that say something about the cooler's state.
  private applyReply(code: number, p: Uint8Array) {
    if (code === 0x22 && p.length >= 4) this.mergeStatus({ rpm: u16(p, 0), targetRpm: u16(p, 2) })
    else if (code === 0x25) this.mergeStatus(p[0] === 5 ? { realtime: true } : { realtime: false, gear: p[0] })
    else if (code === 0x02) this.mergeStatus({ asleep: p[0] === 2 })
    else if (code === 0x45) this.mergeStatus({ strip: !!p[0] })
    else if (code === 0x07) this.mergeStatus({ supply: p[0] })
    else if (code === 0x29) this.mergeStatus({ ramp: p[0] })
  }

  // Settings the firmware has no query for, so remember what was last sent.
  private applySent(code: number, p: number[]) {
    if (code === 0x48) this.mergeStatus({ gearLeds: !!p[0] })
    else if (code === 0x0d) this.mergeStatus({ standby: p[0] })
    else if (code === 0x0c) this.mergeStatus({ autoStart: p[0] === 1 })
    else if (code === 0x2a) this.mergeStatus({ ramp: p[0] })
  }

  private mergeStatus(patch: Partial<Status>) {
    this.update({ status: { ...this.state.status, ...patch }, statusAt: Date.now() })
  }

  private onDisconnected() {
    clearInterval(this.pollTimer)
    if (this.state.connection === 'disconnected') return
    this.device = undefined
    this.writer = undefined
    this.update({ connection: 'disconnected', status: undefined })
    this.log('info', 'Disconnected')
  }

  private update(patch: Partial<CoolerState>) {
    this.state = { ...this.state, ...patch }
  }

  private log(kind: LogEntry['kind'], text: string, bytes?: string) {
    const entry: LogEntry = { id: this.nextLogId++, at: Date.now(), kind, text, hex: bytes }
    this.update({ log: [...this.state.log, entry].slice(-LOG_LIMIT) })
  }
}

// Survives dev-server hot reloads, which would otherwise orphan an open connection.
const g = globalThis as { __cooler?: Cooler }
export const cooler = (g.__cooler ??= new Cooler())
