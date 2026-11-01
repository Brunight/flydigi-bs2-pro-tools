// A minimal WMI client over COM, through bun:ffi: run a WQL query, call a method that takes no
// input. Enough for the Lenovo EC temperatures, without spawning PowerShell every read.
import { CFunction, FFIType, dlopen, ptr, read, toArrayBuffer, type Pointer } from 'bun:ffi'
import { wide } from './text'

const { i32, u32, ptr: P, void: VOID } = FFIType

const ole32 = dlopen('ole32.dll', {
  CoInitializeEx: { args: [P, u32], returns: i32 },
  CoInitializeSecurity: { args: [P, i32, P, P, u32, u32, P, u32, P], returns: i32 },
  CoCreateInstance: { args: [P, P, u32, P, P], returns: i32 },
  CoSetProxyBlanket: { args: [P, u32, u32, P, u32, u32, P, u32], returns: i32 },
}).symbols
const oleaut32 = dlopen('oleaut32.dll', {
  SysAllocString: { args: [P], returns: P },
  SysFreeString: { args: [P], returns: VOID },
  SysStringLen: { args: [P], returns: u32 },
  VariantClear: { args: [P], returns: i32 },
}).symbols

const CLSID_WbemLocator = guid('4590f811-1d3a-11d0-891f-00aa004b2e24')
const IID_IWbemLocator = guid('dc12a687-737f-11cf-884d-00aa004b2e24')
const CLSCTX_INPROC_SERVER = 1
const RPC_C_AUTHN_WINNT = 10
const RPC_C_AUTHN_LEVEL_DEFAULT = 0
const RPC_C_AUTHN_LEVEL_CALL = 3
const RPC_C_IMP_LEVEL_IMPERSONATE = 3
const WBEM_FLAG_RETURN_IMMEDIATELY = 0x10
const WBEM_FLAG_FORWARD_ONLY = 0x20
const WBEM_INFINITE = -1
const RPC_E_CHANGED_MODE = 0x80010106 | 0
const VT_BSTR = 8
const ACCESS_DENIED = new Set([0x80041003 | 0, 0x80070005 | 0])

export class WmiError extends Error {
  constructor(
    what: string,
    readonly hr: number,
  ) {
    super(`${what} failed (0x${(hr >>> 0).toString(16)})`)
  }
  get accessDenied() {
    return ACCESS_DENIED.has(this.hr)
  }
}

function guid(text: string) {
  const hex = text.replace(/-/g, '')
  const b = Buffer.alloc(16)
  b.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0)
  b.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4)
  b.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6)
  b.write(hex.slice(16), 8, 'hex')
  return b
}

function check(hr: number, what: string) {
  if (hr < 0) throw new WmiError(what, hr)
  return hr
}

// COM methods are slots in the object's vtable; the trampolines are built once per slot.
const trampolines = new Map<number, (...args: unknown[]) => number>()
function call(obj: Pointer, slot: number, args: FFIType[], ...values: unknown[]): number {
  const fn = read.ptr(read.ptr(obj, 0) as Pointer, slot * 8)
  let f = trampolines.get(fn)
  if (!f) {
    f = CFunction({ ptr: fn as Pointer, args: [P, ...args], returns: i32 }) as unknown as (...args: unknown[]) => number
    trampolines.set(fn, f)
  }
  return f(obj, ...values)
}
const release = (obj: Pointer) => call(obj, 2, [])

// Out-parameter for an interface pointer.
function out(fn: (slot: Pointer) => number, what: string): Pointer {
  const slot = new BigUint64Array(1)
  check(fn(ptr(slot)), what)
  return Number(slot[0]) as Pointer
}

function bstr(text: string) {
  return oleaut32.SysAllocString(ptr(wide(text)))!
}

function withBstrs<T>(texts: string[], fn: (...b: (Pointer | bigint)[]) => T): T {
  const all = texts.map(bstr)
  try {
    return fn(...all)
  } finally {
    for (const b of all) oleaut32.SysFreeString(b)
  }
}

type Value = string | number | boolean | null

// IWbemClassObject::Get, for the types the callers need.
function getProperty(obj: Pointer, name: string): Value {
  const v = new Uint8Array(24) // VARIANT
  check(call(obj, 4, [P, i32, P, P, P], ptr(wide(name)), 0, ptr(v), null, null), `Get ${name}`)
  try {
    const view = new DataView(v.buffer)
    switch (view.getUint16(0, true)) {
      case VT_BSTR: {
        const p = Number(view.getBigUint64(8, true)) as Pointer
        const len = oleaut32.SysStringLen(p)
        return len ? Buffer.from(toArrayBuffer(p, 0, len * 2)).toString('utf16le') : ''
      }
      case 2: // VT_I2
        return view.getInt16(8, true)
      case 3: // VT_I4
        return view.getInt32(8, true)
      case 11: // VT_BOOL
        return view.getInt16(8, true) !== 0
      case 17: // VT_UI1
        return view.getUint8(8)
      case 18: // VT_UI2
        return view.getUint16(8, true)
      case 19: // VT_UI4
        return view.getUint32(8, true)
      default:
        return null
    }
  } finally {
    oleaut32.VariantClear(ptr(v))
  }
}

let comReady = false
function initCom() {
  if (comReady) return
  const hr = ole32.CoInitializeEx(null, 0) // COINIT_MULTITHREADED
  if (hr !== RPC_E_CHANGED_MODE) check(hr, 'CoInitializeEx')
  // Fails harmlessly when something in the process already set it.
  ole32.CoInitializeSecurity(null, -1, null, null, RPC_C_AUTHN_LEVEL_DEFAULT, RPC_C_IMP_LEVEL_IMPERSONATE, null, 0, null)
  comReady = true
}

export class Wmi {
  private services: Pointer

  constructor(namespace: string) {
    initCom()
    const locator = out(
      (slot) => ole32.CoCreateInstance(ptr(CLSID_WbemLocator), null, CLSCTX_INPROC_SERVER, ptr(IID_IWbemLocator), slot),
      'CoCreateInstance(WbemLocator)',
    )
    try {
      // IWbemLocator::ConnectServer
      this.services = withBstrs([namespace], (ns) =>
        out((slot) => call(locator, 3, [P, P, P, P, i32, P, P, P], ns, null, null, null, 0, null, null, slot), `Connect to ${namespace}`),
      )
    } finally {
      release(locator)
    }
    const services = this.services
    check(
      ole32.CoSetProxyBlanket(services, RPC_C_AUTHN_WINNT, 0, null, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, null, 0),
      'CoSetProxyBlanket',
    )
  }

  // IWbemServices::ExecQuery, then IEnumWbemClassObject::Next until it runs out.
  query(wql: string, properties: string[]): Record<string, Value>[] {
    const flags = WBEM_FLAG_RETURN_IMMEDIATELY | WBEM_FLAG_FORWARD_ONLY
    const items = withBstrs(['WQL', wql], (lang, text) =>
      out((slot) => call(this.services, 20, [P, P, i32, P, P], lang, text, flags, null, slot), wql),
    )
    const rows: Record<string, Value>[] = []
    try {
      const slot = new BigUint64Array(1)
      const count = new Uint32Array(1)
      for (;;) {
        const hr = check(call(items, 4, [i32, u32, P, P], WBEM_INFINITE, 1, ptr(slot), ptr(count)), wql)
        if (hr !== 0 || count[0] === 0) break
        const obj = Number(slot[0]) as Pointer
        try {
          rows.push(Object.fromEntries(properties.map((name) => [name, getProperty(obj, name)])))
        } finally {
          release(obj)
        }
      }
    } finally {
      release(items)
    }
    return rows
  }

  // IWbemServices::ExecMethod; returns one output parameter. Integer inputs only.
  callMethod(path: string, method: string, output: string, input?: Record<string, number>): Value {
    const params = input ? this.inParams(path.split('.')[0]!, method) : null
    if (params) {
      for (const [name, value] of Object.entries(input!)) {
        const v = new Uint8Array(24)
        const view = new DataView(v.buffer)
        view.setUint16(0, 3, true) // VT_I4, which WMI takes for every integer type
        view.setInt32(8, value | 0, true)
        check(call(params, 5, [P, i32, P, i32], ptr(wide(name)), 0, ptr(v), 0), `Put ${name}`) // IWbemClassObject::Put
      }
    }
    const result = withBstrs([path, method], (p, m) =>
      out((slot) => call(this.services, 24, [P, P, i32, P, P, P, P], p, m, 0, null, params, slot, null), method),
    )
    try {
      return getProperty(result, output)
    } finally {
      release(result)
    }
  }

  // An instance of the method's input signature, made once and refilled on every call.
  private params = new Map<string, Pointer>()
  private inParams(className: string, method: string): Pointer {
    const key = `${className}.${method}`
    let params = this.params.get(key)
    if (params) return params
    const cls = withBstrs([className], (name) =>
      out((slot) => call(this.services, 6, [P, i32, P, P, P], name, 0, null, slot, null), `Get class ${className}`),
    )
    try {
      const signature = out((slot) => call(cls, 19, [P, i32, P, P], ptr(wide(method)), 0, slot, null), `GetMethod ${method}`)
      try {
        params = out((slot) => call(signature, 15, [i32, P], 0, slot), `SpawnInstance ${method}`)
      } finally {
        release(signature)
      }
    } finally {
      release(cls)
    }
    this.params.set(key, params)
    return params
  }

  close() {
    for (const params of this.params.values()) release(params)
    this.params.clear()
    release(this.services)
  }
}
