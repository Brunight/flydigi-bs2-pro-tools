import type { Status } from './protocol'

export type Connection = 'disconnected' | 'scanning' | 'connecting' | 'connected'

export interface LogEntry {
  id: number
  at: number
  kind: 'tx' | 'rx' | 'info' | 'error'
  text: string
  hex?: string
}

export interface Reply {
  text: string
  hex: string
  at: number
}

export interface CoolerState {
  connection: Connection
  deviceName?: string
  error?: string
  // From 0xEF frames where the firmware sends them, otherwise built from polled queries,
  // so any field can be missing.
  status?: Partial<Status>
  statusAt?: number
  replies: Record<number, Reply>
  log: LogEntry[]
}
