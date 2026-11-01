// CPU and GPU temperatures from Linux sysfs, plus nvidia-smi for the proprietary NVIDIA driver.
import { readFileSync, readdirSync } from 'node:fs'
import { fileSensor, type Detected, type Sensor } from './index'

const HWMON = '/sys/class/hwmon'
const THERMAL = '/sys/class/thermal'
const NVIDIA_DRIVER = '/sys/bus/pci/drivers/nvidia'

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}
const list = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

interface Hwmon {
  dir: string
  name: string
  temps: { input: string; label: string }[]
}

function hwmons(): Hwmon[] {
  return list(HWMON).map((entry) => {
    const dir = `${HWMON}/${entry}`
    const temps = list(dir)
      .filter((f) => /^temp\d+_input$/.test(f))
      .map((f) => ({ input: `${dir}/${f}`, label: readText(`${dir}/${f.replace('_input', '_label')}`) ?? '' }))
    return { dir, name: readText(`${dir}/name`) ?? '', temps }
  })
}

const pick = (h: Hwmon, ...labels: (string | RegExp)[]) => {
  for (const want of labels) {
    const t = h.temps.find((t) => (typeof want === 'string' ? t.label === want : want.test(t.label)))
    if (t) return t
  }
}

function detectCpu(all: Hwmon[]): Sensor | undefined {
  // Driver-specific package sensors first, then laptop platform drivers that label one "CPU".
  const rules: [string, ...(string | RegExp)[]][] = [
    ['coretemp', 'Package id 0'],
    ['k10temp', 'Tdie', 'Tctl'],
    ['zenpower', 'Tdie', 'Tctl'],
  ]
  for (const [driver, ...labels] of rules) {
    for (const h of all.filter((h) => h.name === driver)) {
      const t = pick(h, ...labels)
      if (t) return fileSensor(t.input, `${driver} ${t.label}`)
    }
  }
  for (const h of all) {
    const t = pick(h, /\bcpu\b/i)
    if (t) return fileSensor(t.input, `${h.name} ${t.label}`)
  }
  for (const zone of list(THERMAL).filter((z) => z.startsWith('thermal_zone'))) {
    if (readText(`${THERMAL}/${zone}/type`) === 'x86_pkg_temp') return fileSensor(`${THERMAL}/${zone}/temp`, 'x86_pkg_temp')
  }
}

// A dGPU in runtime suspend (D3cold) is idle and cool. nvidia-smi would wake it up and keep
// it awake, costing battery, so skip it until something else wakes it.
function nvidiaSensor(): Sensor | undefined {
  const devices = list(NVIDIA_DRIVER).filter((d) => /^[0-9a-f]{4}:/.test(d))
  if (!devices.length) return undefined
  const smi = Bun.which('nvidia-smi')
  if (!smi) return undefined
  return {
    name: 'nvidia-smi',
    async read() {
      if (devices.every((d) => readText(`${NVIDIA_DRIVER}/${d}/power/runtime_status`) === 'suspended')) return undefined
      const proc = Bun.spawn([smi, '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'], {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 5000,
      })
      const out = await new Response(proc.stdout).text()
      if ((await proc.exited) !== 0) return undefined
      const temps = out.split('\n').map(Number).filter((v) => Number.isFinite(v) && v > 0)
      return temps.length ? Math.max(...temps) : undefined
    },
  }
}

// Every GPU sensor found. The hottest one counts.
function detectGpus(all: Hwmon[]): Sensor[] {
  const out: Sensor[] = []
  let fromEc = false
  for (const h of all) {
    if (h.name === 'amdgpu' || h.name === 'nouveau') {
      const t = pick(h, 'junction', 'edge', /./) ?? h.temps[0]
      if (t) out.push(fileSensor(t.input, `${h.name} ${t.label || 'temp'}`))
    } else {
      // Laptop platform drivers (legion_hwmon, thinkpad, asus…) often read the GPU from the EC,
      // which doesn't wake a suspended dGPU.
      const t = pick(h, /\bgpu\b/i)
      if (t) {
        out.push(fileSensor(t.input, `${h.name} ${t.label}`))
        fromEc = true
      }
    }
  }
  // nvidia-smi is the fallback: each call costs ~1% of a core at a 2 s interval, and polling
  // the dGPU can keep it from runtime-suspending. An EC "GPU" sensor reads the same
  // temperature (within 1 °C on a Legion) without touching the GPU.
  if (!fromEc) {
    const nv = nvidiaSensor()
    if (nv) out.push(nv)
  }
  return out
}

export function detect(): Detected {
  const all = hwmons()
  return { cpu: [detectCpu(all)].filter((s) => !!s), gpu: detectGpus(all) }
}
