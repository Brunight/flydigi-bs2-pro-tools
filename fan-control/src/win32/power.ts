// Mains or battery, from GetSystemPowerStatus.
import { FFIType, dlopen, ptr } from 'bun:ffi'

const { GetSystemPowerStatus } = dlopen('kernel32.dll', {
  GetSystemPowerStatus: { args: [FFIType.ptr], returns: FFIType.i32 },
}).symbols

const status = new Uint8Array(12) // SYSTEM_POWER_STATUS
const AC_OFFLINE = 0 // ACLineStatus; 1 is online, 255 unknown

export function onMains() {
  if (!GetSystemPowerStatus(ptr(status))) return true
  return status[0] !== AC_OFFLINE
}
