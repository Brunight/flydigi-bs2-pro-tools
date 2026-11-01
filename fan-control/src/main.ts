// Drives the cooler's fan from CPU and GPU temperatures. On exit it puts the cooler to sleep
// and drops the Bluetooth link.
import { parseArgs } from 'node:util'
import { Cooler, message, sleep } from './cooler'
import { CONFIG_PATH, saveCurve, savedCurve } from './config'
import { DEFAULT_CURVE, parseCurve, rpmFor } from './curve'
import { MAX_RPM, SUPPLY_MAX_RPM, SUPPLY_NAMES } from './protocol'
import { detectSensors, hottest } from './sensors'

const HELP = `Usage: flydigi-fan [options]

Connects to a Flydigi BS2 / BS2 Pro / BS3 cooler over Bluetooth and sets its fan speed from
the hotter of the CPU and GPU. Below the curve's first temperature it turns the cooler off by
disconnecting, and reconnects once it's warm again. Ctrl+C (or SIGTERM) turns the cooler off
and disconnects.

Options:
  --curve <t:rpm,...>   Temperature (°C) to RPM points, 1300–4000 RPM. Without it: the saved
                        curve, else ${DEFAULT_CURVE}
  --save                Save --curve to ${CONFIG_PATH}, then run
  --interval <s>        Seconds between temperature reads (default 2)
  --down-delay <s>      Seconds the fan waits before slowing down (default 10)
  --off-delay <s>       Seconds it has to stay below the curve before turning off (default 30)
  --name <name>         Exact Bluetooth name of the cooler (default: anything like "FlyDigi BS2PRO")
  --cpu <path,...>      CPU temperature files in millidegrees, instead of auto-detection
  --gpu <path,...>      GPU temperature files in millidegrees, instead of auto-detection
  --verbose             Print every reading, not only speed changes
  -h, --help            Show this help

Env: COOLER_NAME works like --name.`

// Resent this often even when nothing changed, so a button press on the cooler, which leaves
// custom-speed mode, doesn't stick.
const REFRESH_MS = 30_000
const RETRY_MS = 5_000
const SCAN_SECONDS = 10
const SHUTDOWN_TIMEOUT_MS = 5_000

const { values: args } = parseArgs({
  options: {
    curve: { type: 'string' },
    save: { type: 'boolean', default: false },
    interval: { type: 'string', default: '2' },
    'down-delay': { type: 'string', default: '10' },
    'off-delay': { type: 'string', default: '30' },
    name: { type: 'string', default: process.env.COOLER_NAME },
    cpu: { type: 'string' },
    gpu: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const log = (text: string) => console.log(`${new Date().toLocaleTimeString()} ${text}`)
const fail = (text: string): never => {
  console.error(text)
  process.exit(1)
}
const seconds = (text: string, flag: string) => {
  const v = Number(text)
  if (!Number.isFinite(v) || v < 0) fail(`--${flag} must be a number of seconds`)
  return v * 1000
}
const deg = (t: number | undefined) => (t === undefined ? '–' : `${Math.round(t)}°C`)

if (args.help) {
  console.log(HELP)
  process.exit(0)
}

let curve: ReturnType<typeof parseCurve> = []
let sensors: ReturnType<typeof detectSensors> = { cpu: [], gpu: [] }
try {
  if (args.save && !args.curve) throw new Error('--save needs --curve')
  curve = args.curve ? parseCurve(args.curve) : (savedCurve() ?? parseCurve(DEFAULT_CURVE))
  if (args.save) {
    saveCurve(curve)
    log(`Saved the curve to ${CONFIG_PATH}`)
  }
  sensors = detectSensors(args.cpu, args.gpu)
} catch (err) {
  fail(message(err))
}
const intervalMs = Math.max(500, seconds(args.interval, 'interval'))
const downDelayMs = seconds(args['down-delay'], 'down-delay')
const offDelayMs = seconds(args['off-delay'], 'off-delay')
// Below the curve's first point, the cooler is off.
const offBelow = curve[0][0]
if (!sensors.cpu.length && !sensors.gpu.length) fail('No CPU or GPU temperature sensor found. Pass --cpu or --gpu.')
log(`CPU sensor: ${sensors.cpu.map((s) => s.name).join(', ') || 'none'}`)
log(`GPU sensor: ${sensors.gpu.map((s) => s.name).join(', ') || 'none'}`)
log(`Curve: ${curve.map(([t, r]) => `${t}°C ${r}`).join(' → ')} RPM, off below ${offBelow}°C`)

// Matches "FlyDigi BS2PRO" and similar unless a name is given.
const wanted = args.name
const match = wanted ? (name: string) => name === wanted : (name: string) => /flydigi|^bs[123]/i.test(name)

let stopping = false
let applied: number | undefined // RPM the cooler was last told
let appliedAt = 0
let lowerSince: number | undefined
let maxRpm = MAX_RPM
let off = false // turned off for being cold, so stay disconnected
let everOn = false
let coldSince: number | undefined

const cooler = new Cooler(match, SCAN_SECONDS, () => {
  applied = undefined
  if (!stopping) log('Cooler disconnected. Reconnecting…')
})

async function connect() {
  log('Scanning for the cooler…')
  try {
    await cooler.connect()
  } catch (err) {
    const hint = /timed out/i.test(message(err)) ? ' If this keeps happening, pair the cooler first.' : ''
    log(`Connect failed: ${message(err)}.${hint}`)
    return false
  }
  if (stopping) return false
  log(`Connected to ${cooler.name}`)
  applied = undefined
  await cooler.wake().catch(() => {})
  await readSupply()
  return true
}

// The firmware clamps the speed to what the power supply allows; clamp here too so the
// requested and actual speeds agree.
async function readSupply() {
  const level = await cooler.supply().catch(() => undefined)
  if (level === undefined) return
  const max = SUPPLY_MAX_RPM[level] ?? MAX_RPM
  if (max !== maxRpm) log(`Power supply: ${SUPPLY_NAMES[level] ?? level}, max ${max} RPM`)
  maxRpm = max
}

async function tick() {
  const [cpu, gpu] = await Promise.all([hottest(sensors.cpu), hottest(sensors.gpu)])
  const temps = [cpu, gpu].filter((t) => t !== undefined)
  const temp = temps.length ? Math.max(...temps) : undefined
  // No reading at all: run flat out rather than guess.
  const target = Math.min(temp === undefined ? MAX_RPM : rpmFor(curve, temp), maxRpm)
  const now = Date.now()
  const cold = temp !== undefined && temp < offBelow
  if (args.verbose) log(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  target ${cold ? 'off' : `${target} RPM`}`)

  if (cold) {
    coldSince ??= now
    // At startup it goes off right away; while running, only once it has stayed cold.
    if (!off && (!everOn || now - coldSince >= offDelayMs)) return turnOffCold(cpu, gpu)
    if (off) return true
  } else {
    coldSince = undefined
    if (off) {
      off = false
      log(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  ≥ ${offBelow}°C, turning the cooler on`)
    }
  }

  if (!cooler.connected && !(await connect())) return false
  if (stopping) return true

  // Speed up at once; slow down only once the lower target has held for the down delay.
  let rpm = target
  if (applied !== undefined && target < applied) {
    lowerSince ??= now
    if (now - lowerSince < downDelayMs) rpm = applied
  } else lowerSince = undefined
  if (rpm === applied && now - appliedAt < REFRESH_MS) return true

  if (now - appliedAt >= REFRESH_MS) await readSupply()
  rpm = Math.min(rpm, maxRpm)
  try {
    await cooler.setSpeed(rpm)
  } catch (err) {
    log(`Set speed failed: ${message(err)}`)
    return true
  }
  if (rpm !== applied) log(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  → ${rpm} RPM`)
  if (rpm === target) lowerSince = undefined
  applied = rpm
  appliedAt = now
  everOn = true
  return true
}

// Connects first if needed: a cooler left awake by an earlier run only sleeps once auto
// standby is set and the link drops.
async function turnOffCold(cpu: number | undefined, gpu: number | undefined) {
  if (!cooler.connected && !(await connect())) return false
  if (stopping) return true
  try {
    await cooler.turnOff()
  } catch (err) {
    cooler.disconnect()
    log(`Turn off failed (${message(err)}), disconnected`)
  }
  off = true
  applied = undefined
  log(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  < ${offBelow}°C, cooler off`)
  return true
}

let wakeLoop = () => {}
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    wakeLoop = () => {
      clearTimeout(timer)
      resolve()
    }
  })

async function run() {
  while (!stopping) {
    const started = Date.now()
    let ok = true
    try {
      ok = await tick()
    } catch (err) {
      log(`Error: ${message(err)}`)
    }
    if (stopping) break
    await pause(ok ? Math.max(0, intervalMs - (Date.now() - started)) : RETRY_MS)
  }
}

const loop = run()

async function shutdown(signal: string) {
  if (stopping) {
    console.log('Forced exit')
    process.exit(1)
  }
  stopping = true
  log(`${signal}: turning the cooler off… (again to force)`)
  wakeLoop()
  // A scan or connect in flight finishes first, so it can't open a link after we've left.
  await loop
  try {
    await Promise.race([cooler.turnOff(), sleep(SHUTDOWN_TIMEOUT_MS).then(() => Promise.reject(new Error('timed out')))])
    log('Cooler off and disconnected')
  } catch (err) {
    cooler.disconnect()
    log(`Turn off failed (${message(err)}), disconnected`)
  }
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(signal))
