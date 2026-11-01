import { createServerFn } from '@tanstack/react-start'
import { buildLightingBuffer, type LightingOptions } from '#/lib/lighting'
import type { Values } from '#/lib/commands'
import { cooler } from './cooler.server'

export const getState = createServerFn({ method: 'GET' }).handler(() => cooler.snapshot())

export const connect = createServerFn({ method: 'POST' }).handler(() => cooler.connect())

export const disconnect = createServerFn({ method: 'POST' }).handler(() => cooler.disconnect())

export const turnOff = createServerFn({ method: 'POST' }).handler(() => cooler.turnOff())

export const turnOn = createServerFn({ method: 'POST' }).handler(() => cooler.turnOn())

export const sendCommand = createServerFn({ method: 'POST' })
  .validator((d: { code: number; values: Values; confirmed?: boolean }) => d)
  .handler(({ data }) => cooler.send(data.code, data.values, data.confirmed))

// Custom speed needs custom-speed mode first; this does both in one call.
export const setSpeed = createServerFn({ method: 'POST' })
  .validator((d: { rpm: number }) => d)
  .handler(async ({ data }) => {
    await cooler.send(0x23, {})
    await cooler.send(0x21, { rpm: String(data.rpm) })
  })

export const uploadLighting = createServerFn({ method: 'POST' })
  .validator((d: LightingOptions) => d)
  .handler(({ data }) => cooler.uploadLighting(buildLightingBuffer(data)))
