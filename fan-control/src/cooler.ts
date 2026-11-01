// The Bluetooth link to the cooler, cut down from debug-dashboard/src/server/cooler.server.ts to what
// fan control needs: connect, set a custom speed, put it to sleep on the way out.
import { Bluetooth } from 'webbluetooth'
import { CMD, FrameParser, NOTIFY_UUID, SERVICE_UUID, WRITE_UUID, frame, le16, u16, type Frame } from './protocol'

// The firmware takes one frame per 5 ms and drops the rest silently, so leave headroom.
const WRITE_GAP_MS = 30
const REPLY_TIMEOUT_MS = 1500
const CONNECT_TIMEOUT_MS = 20_000
// Right after connecting, BlueZ can still be busy (encryption, service discovery) and
// rejects writes with "In Progress" for a moment.
const BUSY_RETRIES = 10
const BUSY_RETRY_MS = 200

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class Cooler {
  name?: string
  private device?: BluetoothDevice
  private writer?: BluetoothRemoteGATTCharacteristic
  private parser = new FrameParser()
  private queue: Promise<unknown> = Promise.resolve()
  // Callers waiting for a reply, per command, oldest first.
  private waiting = new Map<number, ((f: Frame) => void)[]>()

  constructor(
    private match: (name: string) => boolean,
    private scanSeconds: number,
    private onDisconnect: () => void,
  ) {}

  get connected() {
    return !!this.writer
  }

  async connect() {
    if (this.connected) return
    let device: BluetoothDevice | undefined
    try {
      const bluetooth = new Bluetooth({ scanTime: this.scanSeconds, deviceFound: (d) => this.match(d.name ?? '') })
      device = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE_UUID] })
      const found = device
      await withTimeout(
        (async () => {
          const server = await found.gatt!.connect()
          const service = await server.getPrimaryService(SERVICE_UUID)
          const writer = await service.getCharacteristic(WRITE_UUID)
          const notifier = await service.getCharacteristic(NOTIFY_UUID)
          notifier.addEventListener('characteristicvaluechanged', () => {
            const v = notifier.value
            if (v) this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
          })
          found.addEventListener('gattserverdisconnected', () => this.dropped())
          await notifier.startNotifications()
          this.parser.reset()
          this.device = found
          this.writer = writer
        })(),
        CONNECT_TIMEOUT_MS,
        'Connecting',
      )
      this.name = found.name
    } catch (err) {
      // Don't leave a half-open link behind; BlueZ would keep it and the next try fails too.
      device?.gatt?.disconnect()
      this.device = undefined
      this.writer = undefined
      throw err
    }
  }

  disconnect() {
    const device = this.device
    this.device = undefined
    this.writer = undefined
    device?.gatt?.disconnect()
  }

  // Connecting wakes it when auto standby is on; 0x05 covers the case where it isn't.
  async wake() {
    await this.request(CMD.wake)
  }

  async supply(): Promise<number | undefined> {
    return (await this.request(CMD.supply))?.[0]
  }

  // Leaves custom-speed mode. The cooler saves the gear and refuses ones its supply can't drive.
  async selectGear(gear: number) {
    const reply = await this.request(CMD.selectGear, [gear])
    if (reply?.[0] === 5) throw new Error(`Gear ${gear} refused: the power supply is too weak`)
    if (reply?.[0] !== 1) throw new Error(reply ? `Gear ${gear} refused (status ${reply[0]})` : 'No reply to select gear')
  }

  // RPM of gears 1–4.
  async gearSpeeds(): Promise<number[] | undefined> {
    const p = await this.request(CMD.gearSpeeds)
    return p && p.length >= 8 ? [0, 2, 4, 6].map((i) => u16(p, i)) : undefined
  }

  async strip(): Promise<boolean | undefined> {
    const p = await this.request(CMD.stripState)
    return p?.length ? p[0] !== 0 : undefined
  }

  async setStrip(on: boolean) {
    await this.request(CMD.strip, [on ? 1 : 0])
  }

  // The firmware has no query for the gear LEDs, so the caller remembers the setting.
  async setGearLeds(on: boolean) {
    await this.request(CMD.gearLeds, [on ? 1 : 0])
  }

  // Custom-speed mode is dropped when the last host disconnects or someone presses the
  // cooler's button, so enter it again whenever the cooler refuses the speed.
  async setSpeed(rpm: number) {
    let reply = await this.request(CMD.setSpeed, le16(rpm))
    if (reply?.[0] === 2) {
      await this.request(CMD.enterCustom)
      reply = await this.request(CMD.setSpeed, le16(rpm))
    }
    if (reply?.[0] !== 1) throw new Error(reply ? `Cooler refused ${rpm} RPM (status ${reply[0]})` : 'No reply to set speed')
  }

  // There is no off command. The cooler sleeps when its last host goes away while auto
  // standby is on, so: standby to "when disconnected", then drop the link. A USB host or
  // another Bluetooth connection (a paired laptop's HID link counts) keeps it awake.
  async turnOff() {
    if (this.connected) {
      await this.request(CMD.standby, [1])
      await sleep(300) // let the setting land before the link goes
    }
    this.disconnect()
  }

  // Sends a command and waits for its reply. Undefined if none came in time.
  private async request(code: number, payload: number[] = []): Promise<Uint8Array | undefined> {
    let resolve!: (f: Frame | undefined) => void
    const reply = new Promise<Frame | undefined>((r) => (resolve = r))
    const queue = this.waiting.get(code) ?? []
    queue.push(resolve)
    this.waiting.set(code, queue)
    const forget = () => {
      const i = queue.indexOf(resolve)
      if (i >= 0) queue.splice(i, 1)
    }
    const timer = setTimeout(() => {
      forget()
      resolve(undefined)
    }, REPLY_TIMEOUT_MS)
    try {
      await this.write(frame(code, payload))
    } catch (err) {
      clearTimeout(timer)
      forget()
      throw err
    }
    const f = await reply
    clearTimeout(timer)
    return f?.payload
  }

  private write(bytes: Uint8Array<ArrayBuffer>) {
    const run = this.queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const writer = this.writer
        if (!writer) throw new Error('Not connected')
        try {
          if (writer.properties.write) await writer.writeValueWithResponse(bytes)
          else await writer.writeValueWithoutResponse(bytes)
          break
        } catch (err) {
          if (attempt >= BUSY_RETRIES || !/in progress/i.test(message(err))) throw err
          await sleep(BUSY_RETRY_MS)
        }
      }
      await sleep(WRITE_GAP_MS)
    })
    // Keep the queue alive after a failure; the caller still gets the error.
    this.queue = run.catch(() => {})
    return run
  }

  private onData(data: Uint8Array) {
    for (const f of this.parser.feed(data)) this.waiting.get(f.cmd)?.shift()?.(f)
  }

  private dropped() {
    if (!this.device) return
    this.device = undefined
    this.writer = undefined
    this.onDisconnect()
  }
}
