// Drives the cooler's fan from CPU and GPU temperatures. On exit it puts the cooler to sleep
// and drops the Bluetooth link.
import { parseArgs } from 'node:util'
import { Cooler, message, sleep } from './cooler'
import { spawn } from 'node:child_process'
import { CONFIG_PATH, ensureConfig, saveCurve, saveGearLeds, savedCurve, savedGearLeds } from './config'
import { DEFAULT_CURVE, parseCurve, rpmFor } from './curve'
import { openPath } from './open'
import { MAX_RPM, MIN_RPM, SUPPLY_MAX_RPM, SUPPLY_NAMES } from './protocol'
import { detectSensors, hottest } from './sensors'
import { startTray, type MenuItem, type Tray } from './tray'

const HELP = `Usage: flydigi-fan [options]

Connects to a Flydigi BS2 / BS2 Pro / BS3 cooler over Bluetooth and sets its fan speed from
the hotter of the CPU and GPU. Below the curve's first temperature it turns the cooler off by
disconnecting, and reconnects once it's warm again. Ctrl+C (or SIGTERM) turns the cooler off
and disconnects.

A tray icon shows where the temperature sits on the curve. Its menu switches between Smart
(this curve) and the cooler's fixed gears, toggles the light strip and gear LEDs, forces the
cooler off, opens the config file, restarts and quits.

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
  --no-tray             Don't show a tray icon
  -h, --help            Show this help

Env: COOLER_NAME works like --name.`

// Resent this often even when nothing changed, so a button press on the cooler, which leaves
// custom-speed mode, doesn't stick.
const REFRESH_MS = 30_000
const RETRY_MS = 5_000
const SCAN_SECONDS = 10
const SHUTDOWN_TIMEOUT_MS = 5_000
// Share of the tray ring shown at the lowest speed.
const RING_MIN = 0.05

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
    'no-tray': { type: 'boolean', default: false },
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
let sensors: Awaited<ReturnType<typeof detectSensors>> = { cpu: [], gpu: [] }
let gearLeds = true // saved, because the cooler can't report it
try {
  gearLeds = savedGearLeds()
  if (args.save && !args.curve) throw new Error('--save needs --curve')
  curve = args.curve ? parseCurve(args.curve) : (savedCurve() ?? parseCurve(DEFAULT_CURVE))
  if (args.save) {
    saveCurve(curve)
    log(`Saved the curve to ${CONFIG_PATH}`)
  }
  sensors = await detectSensors(args.cpu, args.gpu, log)
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
let off = false // turned off (cold or forced), so stay disconnected
let everOn = false
let coldSince: number | undefined
let forceOff = false // from the tray menu, never saved
let reading: { cpu?: number; gpu?: number; temp?: number } = {}

// Smart follows the curve; a gear hands the speed to the cooler. Always starts as Smart.
type Mode = 'smart' | 1 | 2 | 3 | 4
const GEARS = [1, 2, 3, 4] as const
let mode: Mode = 'smart'
let gearApplied: number | undefined // gear the cooler was last told
let gearAppliedAt = 0
let gearRpm: number[] | undefined // per gear, from the cooler
let supplyLevel: number | undefined
const refusedGears = new Set<number>() // refused since connecting
let stripOn: boolean | undefined // read from the cooler

const cooler = new Cooler(match, SCAN_SECONDS, () => {
  applied = undefined
  gearApplied = undefined
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
  gearApplied = undefined
  refusedGears.clear()
  await cooler.wake().catch(() => {})
  gearRpm = (await cooler.gearSpeeds().catch(() => undefined)) ?? gearRpm
  await readSupply()
  stripOn = await cooler.strip().catch(() => undefined)
  await cooler.setGearLeds(gearLeds).catch((err) => log(`Gear LEDs: ${message(err)}`))
  return true
}

// A gear is out when its speed is over what the power supply allows, or the cooler refused it.
function supportedGear(gear: number) {
  if (refusedGears.has(gear)) return false
  const rpm = gearRpm?.[gear - 1]
  const max = supplyLevel ? SUPPLY_MAX_RPM[supplyLevel] : undefined
  return rpm === undefined || max === undefined || rpm <= max
}

function setMode(next: Mode, why?: string) {
  if (next === mode) return
  mode = next
  applied = undefined
  gearApplied = undefined
  lowerSince = undefined
  log(`Mode: ${next === 'smart' ? 'Smart' : `Gear ${next}`}${why ? ` (${why})` : ''}`)
}

// The firmware clamps the speed to what the power supply allows; clamp here too so the
// requested and actual speeds agree.
async function readSupply() {
  const level = await cooler.supply().catch(() => undefined)
  if (level === undefined) return
  const max = SUPPLY_MAX_RPM[level] ?? MAX_RPM
  if (max !== maxRpm) log(`Power supply: ${SUPPLY_NAMES[level] ?? level}, max ${max} RPM`)
  maxRpm = max
  supplyLevel = level
  if (mode !== 'smart' && !supportedGear(mode)) setMode('smart', `the power supply can't drive gear ${mode}`)
}

async function tick() {
  const [cpu, gpu] = await Promise.all([hottest(sensors.cpu), hottest(sensors.gpu)])
  const temps = [cpu, gpu].filter((t) => t !== undefined)
  const temp = temps.length ? Math.max(...temps) : undefined
  // No reading at all: run flat out rather than guess.
  const target = Math.min(temp === undefined ? MAX_RPM : rpmFor(curve, temp), maxRpm)
  const now = Date.now()
  const cold = temp !== undefined && temp < offBelow
  reading = { cpu, gpu, temp }
  if (args.verbose) log(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  target ${forceOff || cold ? 'off' : `${target} RPM`}`)

  if (forceOff) return off || powerOff(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  force off, cooler off`)
  if (mode !== 'smart') {
    // A gear ignores the temperature, so it also wakes a cooler that was off for being cold.
    coldSince = undefined
    if (off) {
      off = false
      log(`Gear ${mode}: turning the cooler on`)
    }
  } else if (cold) {
    coldSince ??= now
    // At startup it goes off right away; while running, only once it has stayed cold.
    if (!off && (!everOn || now - coldSince >= offDelayMs)) {
      return powerOff(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  < ${offBelow}°C, cooler off`)
    }
    if (off) return true
  } else {
    coldSince = undefined
    if (off) {
      off = false
      log(`CPU ${deg(cpu)}  GPU ${deg(gpu)}  ≥ ${offBelow}°C, turning the cooler on`)
    }
  }

  const tickMode = mode
  if (!cooler.connected && !(await connect())) return false
  // Connecting takes seconds; if the menu changed things meanwhile, start over with fresh state.
  if (stopping || forceOff || mode !== tickMode) return true
  if (mode !== 'smart') return applyGear(mode, now)

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
  gearApplied = undefined
  everOn = true
  return true
}

// Resent every REFRESH_MS like the custom speed, in case the cooler's button changed it.
async function applyGear(gear: number, now: number) {
  if (gearApplied === gear && now - gearAppliedAt < REFRESH_MS) return true
  if (now - gearAppliedAt >= REFRESH_MS) await readSupply()
  if (mode !== gear) return true // readSupply fell back to Smart
  try {
    await cooler.selectGear(gear)
  } catch (err) {
    log(message(err))
    if (/too weak/.test(message(err))) {
      refusedGears.add(gear)
      setMode('smart', 'gear refused')
    }
    return true
  }
  if (gearApplied !== gear) log(`Gear ${gear}${gearRpm?.[gear - 1] ? ` → ${gearRpm[gear - 1]} RPM` : ''}`)
  gearApplied = gear
  gearAppliedAt = now
  applied = undefined // Smart re-enters custom speed when chosen again
  everOn = true
  return true
}

// Connects first if needed: a cooler left awake by an earlier run only sleeps once auto
// standby is set and the link drops.
async function powerOff(why: string) {
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
  gearApplied = undefined
  log(why)
  return true
}

function updateTray() {
  if (!tray) return
  const { cpu, gpu, temp } = reading
  const gearSpeed = mode === 'smart' ? undefined : gearRpm?.[mode - 1]
  const status = forceOff
    ? 'Off (forced)'
    : off
      ? `Off: below ${offBelow}°C`
      : !cooler.connected
        ? 'Connecting…'
        : mode !== 'smart'
          ? `Gear ${mode}${gearSpeed ? ` · ${gearSpeed} RPM` : ''}`
          : applied !== undefined
            ? `${applied} RPM`
            : 'Starting…'
  let fill: number
  if (mode !== 'smart') {
    // A gear has no curve: show its speed on the cooler's range instead.
    fill = gearSpeed ? (gearSpeed - MIN_RPM) / (MAX_RPM - MIN_RPM) : 0.5
  } else {
    // Where the temperature sits on the curve, from its first point to its last.
    const first = curve[0]![0]
    const last = curve[curve.length - 1]![0]
    fill = temp === undefined ? 1 : last > first ? (temp - first) / (last - first) : 1
  }
  // A running fan always shows a sliver of ring, even at the lowest speed.
  const progress = RING_MIN + (1 - RING_MIN) * Math.min(1, Math.max(0, fill))
  tray.update({
    progress,
    off: forceOff || off || !cooler.connected,
    tooltip: `CPU ${deg(cpu)} · GPU ${deg(gpu)} · ${status}`,
    menu: buildMenu(),
  })
}

// Menu clicks: change the state, then let the loop act on it right away.
function menuAction(fn: () => void) {
  return () => {
    if (stopping) return
    fn()
    updateTray()
    wakeLoop()
  }
}

function buildMenu(): MenuItem[] {
  const gearLabel = (gear: number) => {
    const rpm = gearRpm?.[gear - 1]
    return rpm ? `Gear ${gear} · ${rpm} RPM` : `Gear ${gear}`
  }
  return [
    {
      kind: 'submenu',
      label: `Mode: ${mode === 'smart' ? 'Smart' : `Gear ${mode}`}`,
      items: [
        { kind: 'radio', label: 'Smart', checked: mode === 'smart', onClick: menuAction(() => setMode('smart')) },
        ...GEARS.map(
          (gear): MenuItem => ({
            kind: 'radio',
            label: gearLabel(gear),
            checked: mode === gear,
            enabled: supportedGear(gear),
            onClick: menuAction(() => setMode(gear)),
          }),
        ),
      ],
    },
    {
      kind: 'check',
      label: 'Light strip',
      checked: stripOn ?? false,
      enabled: cooler.connected && stripOn !== undefined,
      onClick: menuAction(() => {
        const on = !stripOn
        cooler
          .setStrip(on)
          .then(() => {
            stripOn = on
            log(`Light strip: ${on ? 'on' : 'off'}`)
            updateTray()
          })
          .catch((err) => log(`Light strip: ${message(err)}`))
      }),
    },
    {
      kind: 'check',
      label: 'Gear LEDs',
      checked: gearLeds,
      onClick: menuAction(() => {
        gearLeds = !gearLeds
        log(`Gear LEDs: ${gearLeds ? 'on' : 'off'}`)
        try {
          saveGearLeds(gearLeds)
        } catch (err) {
          log(`Couldn't save the gear LED setting: ${message(err)}`)
        }
        // Not connected: connect() applies the saved setting.
        if (cooler.connected) cooler.setGearLeds(gearLeds).catch((err) => log(`Gear LEDs: ${message(err)}`))
      }),
    },
    {
      kind: 'check',
      label: 'Force off',
      checked: forceOff,
      onClick: menuAction(() => {
        forceOff = !forceOff
        log(`Force off: ${forceOff ? 'on' : 'off'}`)
      }),
    },
    { kind: 'separator' },
    {
      kind: 'action',
      label: 'Open config file',
      onClick: () => {
        try {
          ensureConfig(curve)
        } catch (err) {
          log(`Couldn't create ${CONFIG_PATH}: ${message(err)}`)
        }
        openPath(CONFIG_PATH, log)
      },
    },
    { kind: 'action', label: 'Restart', onClick: () => void (stopping || shutdown('Restart', true)) },
    { kind: 'action', label: 'Quit', onClick: () => void (stopping || shutdown('Quit')) },
  ]
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

const tray: Tray | undefined = args['no-tray'] ? undefined : await startTray(log)
// The first tick can spend seconds connecting; show the menu before that.
updateTray()

async function run() {
  while (!stopping) {
    const started = Date.now()
    let ok = true
    try {
      ok = await tick()
    } catch (err) {
      log(`Error: ${message(err)}`)
    }
    updateTray()
    if (stopping) break
    await pause(ok ? Math.max(0, intervalMs - (Date.now() - started)) : RETRY_MS)
  }
}

const loop = run()

// Same arguments as this run. In a compiled executable argv[1] is the embedded entry point
// (/$bunfs/...), which execPath already is; from source it's the script, which bun needs.
function relaunch() {
  const compiled = process.argv[1]?.startsWith('/$bunfs/') || process.argv[1]?.startsWith('B:/~BUN/')
  const argv = process.argv.slice(compiled ? 2 : 1)
  const child = spawn(process.execPath, argv, { stdio: 'inherit', detached: true })
  child.unref()
  log(`Restarted as PID ${child.pid}`)
}

async function shutdown(signal: string, restart = false) {
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
  tray?.close()
  if (restart) relaunch()
  process.exit(0)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => void shutdown(signal))
