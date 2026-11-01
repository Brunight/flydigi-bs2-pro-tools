// CPU and GPU temperature sensors. Auto-detection is per platform (./linux, ./windows); the
// --cpu/--gpu files work everywhere.
import { existsSync, readFileSync } from 'node:fs'

export interface Sensor {
  name: string
  read(): Promise<number | undefined> // °C, undefined when there's nothing to read right now
}

export interface Detected {
  cpu: Sensor[]
  gpu: Sensor[]
}

// Temperatures in millidegrees, like sysfs.
export function fileSensor(path: string, name = path): Sensor {
  return {
    name,
    async read() {
      let v = NaN
      try {
        v = Number(readFileSync(path, 'utf8').trim())
      } catch {}
      return Number.isFinite(v) && v > 0 ? v / 1000 : undefined
    },
  }
}

// Keep each process.platform check inline, next to its import(): when the platform is known
// at build time (bun build --compile --target, or --define process.platform), the bundler
// folds the check and leaves the other platform's module, and its dependencies, out.
async function detectPlatform(want: { cpu: boolean; gpu: boolean }, log: (text: string) => void): Promise<Detected> {
  if (process.platform === 'linux') return (await import('./linux')).detect()
  if (process.platform === 'win32') return (await import('./windows')).detect(want, log)
  return { cpu: [], gpu: [] }
}

export async function detectSensors(cpuPaths: string | undefined, gpuPaths: string | undefined, log: (text: string) => void) {
  const fromPaths = (paths: string) =>
    paths.split(',').map((p) => {
      const path = p.trim()
      if (!existsSync(path)) throw new Error(`Sensor file not found: ${path}`)
      return fileSensor(path)
    })
  const auto = cpuPaths && gpuPaths ? { cpu: [], gpu: [] } : await detectPlatform({ cpu: !cpuPaths, gpu: !gpuPaths }, log)
  return {
    cpu: cpuPaths ? fromPaths(cpuPaths) : auto.cpu,
    gpu: gpuPaths ? fromPaths(gpuPaths) : auto.gpu,
  }
}

// Highest reading of a group, or undefined when none of them reads.
export async function hottest(sensors: Sensor[]) {
  const temps = await Promise.all(sensors.map((s) => s.read().catch(() => undefined)))
  const valid = temps.filter((t) => t !== undefined)
  return valid.length ? Math.max(...valid) : undefined
}
