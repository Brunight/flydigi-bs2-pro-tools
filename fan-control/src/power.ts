// Whether the laptop runs on mains power. On battery it's normally off the cooler, so there's
// nothing to drive and scanning for it would only drain the battery.
import { readFileSync, readdirSync } from 'node:fs'

const SUPPLIES = '/sys/class/power_supply'

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

// On battery only when the machine has a battery and no charger (Mains, USB-C…) is online.
// Device batteries (a wireless mouse's) don't count. A desktop, or anything unreadable, is mains.
function linuxOnMains() {
  let names: string[]
  try {
    names = readdirSync(SUPPLIES)
  } catch {
    return true
  }
  let battery = false
  for (const name of names) {
    const dir = `${SUPPLIES}/${name}`
    if (readText(`${dir}/type`) === 'Battery') {
      if (readText(`${dir}/scope`) !== 'Device') battery = true
    } else if (readText(`${dir}/online`) === '1') return true
  }
  return !battery
}

// Keep each process.platform check inline, next to its import(); see ./sensors.
export async function powerSource(): Promise<() => boolean> {
  if (process.platform === 'linux') return linuxOnMains
  if (process.platform === 'win32') return (await import('./win32/power')).onMains
  return () => true
}
