import { describe, expect, test } from 'bun:test'
import { COMMANDS, commandByCode, encodeCommand, initialValues } from './commands'
import { buildLightingBuffer, lightingUpload } from './lighting'
import { FrameParser, decodeStatus, frame, parseHex } from './protocol'

const bytes = (s: string) => Uint8Array.from(parseHex(s))

describe('frame', () => {
  test('matches the firmware checksum', () => {
    expect(frame(0x21, [0x60, 0x09])).toEqual(bytes('5AA5 21 04 60 09 8E'))
    expect(frame(0x23)).toEqual(bytes('5AA5 23 02 25'))
  })

  test('refuses the firmware-erase command and oversized payloads', () => {
    expect(() => frame(0xdf)).toThrow()
    expect(() => frame(0x42, new Array(16).fill(0))).toThrow()
  })
})

describe('FrameParser', () => {
  // Captured BS3 Pro status frame from flydigictl, report ID stripped.
  const status = bytes('5AA5 EF 0D 68 03 05 6C 07 6C 07 01 01 B4 23 2B')

  test('reassembles frames split across notifications, skipping junk', () => {
    const p = new FrameParser()
    const ack = bytes('00 5AA5 21 03 01 25')
    expect(p.feed(Uint8Array.from([...ack, ...status.slice(0, 7)])).map((f) => f.cmd)).toEqual([0x21])
    const [f] = p.feed(status.slice(7))
    expect(f.cmd).toBe(0xef)
    expect(decodeStatus(f.payload)).toMatchObject({
      asleep: false,
      gear: 1,
      bleLink: true,
      usb: false,
      supply: 3,
      realtime: true,
      rpm: 1900,
      targetRpm: 1900,
      gearLeds: true,
      strip: true,
    })
  })

  test('drops frames with a bad checksum', () => {
    const p = new FrameParser()
    const bad = status.slice()
    bad[8] ^= 1
    expect(p.feed(bad)).toEqual([])
    expect(p.feed(status)).toHaveLength(1)
  })
})

describe('commands', () => {
  test('every default value encodes', () => {
    for (const cmd of COMMANDS) expect(() => encodeCommand(cmd, initialValues(cmd))).not.toThrow()
  })

  test('the catalog has no firmware-erase entry', () => {
    expect(commandByCode.has(0xdf)).toBe(false)
  })

  test('rejects out-of-range values', () => {
    const gear = commandByCode.get(0x08)!
    expect(encodeCommand(gear, { gear: '4' })).toEqual([4])
    expect(() => encodeCommand(gear, { gear: '0' })).toThrow()
    expect(() => encodeCommand(gear, { gear: '5' })).toThrow()
    expect(() => encodeCommand(commandByCode.get(0x21)!, { rpm: '0' })).toThrow()
    expect(() => encodeCommand(commandByCode.get(0x47)!, { index: '0', data: '00'.repeat(11) })).toThrow()
  })

  test('set gear speed sends a zero-based gear', () => {
    expect(encodeCommand(commandByCode.get(0x26)!, { gear: '1', rpm: '1700' })).toEqual([0, 0xa4, 0x06])
  })
})

describe('lighting', () => {
  test('BS2 Pro buffer is 306 bytes sent as 31 frames', () => {
    const buf = buildLightingBuffer({ effect: 'breathe', color: '#0078ff', speed: 15, brightness: 100, leds: 10 })
    expect(buf).toHaveLength(306)
    expect(buf.slice(0, 6)).toEqual([0, 2, 0, 1, 15, 100])
    expect(buf.slice(6, 12)).toEqual([0, 0, 0, 0, 0x78, 0xff]) // LED 0: black, then colour
    const upload = lightingUpload(buf)
    expect(upload).toHaveLength(33)
    expect(upload.map(([c]) => c).filter((c) => c === 0x47)).toHaveLength(31)
    for (const [code, payload] of upload) expect(() => frame(code, payload)).not.toThrow()
  })

  test('BS3 buffer matches the firmware size of 186 bytes', () => {
    expect(buildLightingBuffer({ effect: 'solid', color: '#ff0000', speed: 1, brightness: 50, leds: 6 })).toHaveLength(186)
  })
})
