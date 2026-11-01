// CPU and GPU temperatures on Windows. Lenovo Legion laptops report both from the EC over WMI,
// the same readings legion_hwmon gives on Linux; that needs administrator rights. NVML
// (nvml.dll, installed with the NVIDIA driver) reads an NVIDIA GPU without them.
import { FFIType, dlopen, ptr, type Pointer } from 'bun:ffi'
import { wide } from '../win32/text'
import { Wmi, WmiError } from '../win32/wmi'
import type { Detected, Sensor } from './index'

const { i32, u32, ptr: P } = FFIType

// LENOVO_OTHER_METHOD.GetFeatureValue IDs, listed in LENOVO_CAPABILITY_DATA_00 on 2024+ models.
const FEATURE_CPU_TEMP = 0x05040000
const FEATURE_GPU_TEMP = 0x05050000

const plausible = (t: number) => (t > 0 && t < 150 ? t : undefined)

// One WMI connection for both sensors, opened again after a failure (the WMI service restarts).
function lenovoSensors(want: { cpu: boolean; gpu: boolean }, log: (text: string) => void): { cpu?: Sensor; gpu?: Sensor } {
  let wmi: Wmi | undefined
  const withWmi = <T>(fn: (wmi: Wmi) => T): T => {
    try {
      return fn((wmi ??= new Wmi('ROOT\\WMI')))
    } catch (err) {
      wmi?.close()
      wmi = undefined
      throw err
    }
  }

  let reader: ((which: 'cpu' | 'gpu') => number) | undefined
  try {
    // The class list is readable without administrator rights, so non-Lenovo machines stay quiet.
    const has = (cls: string) => withWmi((w) => w.query(`SELECT * FROM meta_class WHERE __CLASS = '${cls}'`, []).length > 0)
    const path = (cls: string) => String(withWmi((w) => w.query(`SELECT InstanceName FROM ${cls}`, ['__RELPATH'])[0]?.__RELPATH ?? ''))
    if (has('LENOVO_OTHER_METHOD') && has('LENOVO_CAPABILITY_DATA_00')) {
      const ids = new Set(withWmi((w) => w.query('SELECT IDs FROM LENOVO_CAPABILITY_DATA_00', ['IDs'])).map((r) => Number(r.IDs) >>> 0))
      const method = path('LENOVO_OTHER_METHOD')
      if (method && ids.has(FEATURE_CPU_TEMP)) {
        reader = (which) =>
          Number(withWmi((w) => w.callMethod(method, 'GetFeatureValue', 'value', { IDs: which === 'cpu' ? FEATURE_CPU_TEMP : FEATURE_GPU_TEMP })))
      }
    }
    // Older models: GameZone. Gen 10 still has these methods, but they return 0.
    if (!reader && has('LENOVO_GAMEZONE_DATA')) {
      const gameZone = path('LENOVO_GAMEZONE_DATA')
      if (gameZone) reader = (which) => Number(withWmi((w) => w.callMethod(gameZone, which === 'cpu' ? 'GetCPUTemp' : 'GetGPUTemp', 'Data')))
    }
  } catch (err) {
    if (err instanceof WmiError && err.accessDenied) {
      if (want.cpu) log('The Lenovo EC temperatures need administrator rights: run as administrator for the CPU temperature')
    } else log(`Lenovo EC sensors: ${err instanceof Error ? err.message : err}`)
    return {}
  }
  if (!reader) return {}

  // Only keep a sensor that reads something now; a model without it reports 0.
  const sensor = (which: 'cpu' | 'gpu'): Sensor | undefined => {
    try {
      if (plausible(reader(which)) === undefined) return undefined
    } catch {
      return undefined
    }
    return {
      name: `Lenovo EC ${which.toUpperCase()}`,
      async read() {
        return plausible(reader(which))
      },
    }
  }
  return { cpu: want.cpu ? sensor('cpu') : undefined, gpu: want.gpu ? sensor('gpu') : undefined }
}

const DISPLAY_CLASS = '{4d36e968-e325-11ce-bfc1-08002be10318}'
const CM_GETIDLIST_FILTER_PRESENT = 0x100
const CM_GETIDLIST_FILTER_CLASS = 0x200
const POWER_DEVICE_D0 = 1
// DEVPKEY_Device_PowerData: {a45c254e-df1c-4efd-8020-67d146a850e0}, 32
const DEVPKEY_POWER_DATA = Buffer.from('4e255ca41cdffd4e802067d146a850e020000000', 'hex')

const cfgmgr = () =>
  dlopen('cfgmgr32.dll', {
    CM_Get_Device_ID_List_SizeW: { args: [P, P, u32], returns: u32 },
    CM_Get_Device_ID_ListW: { args: [P, P, u32, u32], returns: u32 },
    CM_Locate_DevNodeW: { args: [P, P, u32], returns: u32 },
    CM_Get_DevNode_PropertyW: { args: [u32, P, P, P, P, u32], returns: u32 },
  }).symbols

// PnP instance IDs of the NVIDIA display adapters.
function nvidiaAdapters(cm: ReturnType<typeof cfgmgr>): string[] {
  const filter = ptr(wide(DISPLAY_CLASS))
  const flags = CM_GETIDLIST_FILTER_CLASS | CM_GETIDLIST_FILTER_PRESENT
  const size = new Uint32Array(1)
  if (cm.CM_Get_Device_ID_List_SizeW(ptr(size), filter, flags) !== 0 || !size[0]) return []
  const list = Buffer.alloc(size[0] * 2)
  if (cm.CM_Get_Device_ID_ListW(filter, ptr(list), size[0], flags) !== 0) return []
  return list
    .toString('utf16le')
    .split('\0')
    .filter((id) => /^PCI\\VEN_10DE&/i.test(id))
}

// The power state the PnP manager last saw, which doesn't wake the device. A missing device
// (the dGPU switched off) counts as asleep; an unreadable state as awake.
function awake(cm: ReturnType<typeof cfgmgr>, id: string) {
  const node = new Uint32Array(1)
  if (cm.CM_Locate_DevNodeW(ptr(node), ptr(wide(id)), 0) !== 0) return false
  const type = new Uint32Array(1)
  const data = new Uint32Array(14) // CM_POWER_DATA
  const size = new Uint32Array([data.byteLength])
  if (cm.CM_Get_DevNode_PropertyW(node[0]!, ptr(DEVPKEY_POWER_DATA), ptr(type), ptr(data), ptr(size), 0) !== 0) return true
  return data[1] === POWER_DEVICE_D0 // PD_MostRecentPowerState
}

// A dGPU in runtime D3 is idle and cool, and querying it would wake it, so skip it then.
// NVML is opened for each read and shut down after, so nothing is held on the GPU in between.
function nvidiaSensor(): Sensor | undefined {
  let cm: ReturnType<typeof cfgmgr>
  let nvml
  try {
    cm = cfgmgr()
    if (!nvidiaAdapters(cm).length) return undefined
    nvml = dlopen('nvml.dll', {
      nvmlInit_v2: { args: [], returns: i32 },
      nvmlShutdown: { args: [], returns: i32 },
      nvmlDeviceGetCount_v2: { args: [P], returns: i32 },
      nvmlDeviceGetHandleByIndex_v2: { args: [u32, P], returns: i32 },
      nvmlDeviceGetTemperature: { args: [P, u32, P], returns: i32 },
    }).symbols
  } catch {
    return undefined
  }
  const n = nvml
  return {
    name: 'NVML',
    async read() {
      if (!nvidiaAdapters(cm).some((id) => awake(cm, id))) return undefined
      if (n.nvmlInit_v2() !== 0) return undefined
      try {
        const count = new Uint32Array(1)
        if (n.nvmlDeviceGetCount_v2(ptr(count)) !== 0) return undefined
        const handle = new BigUint64Array(1)
        const temp = new Uint32Array(1)
        const temps: number[] = []
        for (let i = 0; i < count[0]!; i++) {
          if (n.nvmlDeviceGetHandleByIndex_v2(i, ptr(handle)) !== 0) continue
          // NVML_TEMPERATURE_GPU
          if (n.nvmlDeviceGetTemperature(Number(handle[0]) as Pointer, 0, ptr(temp)) === 0) temps.push(temp[0]!)
        }
        const t = temps.length ? Math.max(...temps) : undefined
        return t === undefined ? undefined : plausible(t)
      } finally {
        n.nvmlShutdown()
      }
    },
  }
}

export function detect(want: { cpu: boolean; gpu: boolean }, log: (text: string) => void): Detected {
  const ec = lenovoSensors(want, log)
  const gpu = ec.gpu ? [ec.gpu] : []
  // Like on Linux, NVML is only the fallback when the EC doesn't report the GPU.
  if (want.gpu && !ec.gpu) {
    const nv = nvidiaSensor()
    if (nv) gpu.push(nv)
  }
  return { cpu: ec.cpu ? [ec.cpu] : [], gpu }
}
