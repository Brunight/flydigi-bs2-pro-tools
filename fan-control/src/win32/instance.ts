// One instance per Windows session: a named mutex, owned by the JS thread. Ownership comes from
// a zero-timeout wait instead of ERROR_ALREADY_EXISTS, because GetLastError isn't reliable
// across bun:ffi calls. A mutex left by a crashed instance comes back abandoned, which is ours.
import { FFIType, dlopen, ptr } from 'bun:ffi'
import { wide } from './text'

const { i32, u32, ptr: P } = FFIType
const kernel32 = dlopen('kernel32.dll', {
  CreateMutexW: { args: [P, i32, P], returns: P },
  WaitForSingleObject: { args: [P, u32], returns: u32 },
  ReleaseMutex: { args: [P], returns: i32 },
  CloseHandle: { args: [P], returns: i32 },
}).symbols

const NAME = 'Local\\flydigi-fan'
const WAIT_OBJECT_0 = 0
const WAIT_ABANDONED = 0x80

export function claim(): { release(): void } | undefined {
  // NULL when an elevated instance owns it: its mutex is access-denied to a normal one.
  const mutex = kernel32.CreateMutexW(null, 0, ptr(wide(NAME)))
  if (!mutex) return undefined
  const result = kernel32.WaitForSingleObject(mutex, 0)
  if (result !== WAIT_OBJECT_0 && result !== WAIT_ABANDONED) {
    kernel32.CloseHandle(mutex)
    return undefined
  }
  return {
    release() {
      kernel32.ReleaseMutex(mutex)
      kernel32.CloseHandle(mutex)
    },
  }
}
