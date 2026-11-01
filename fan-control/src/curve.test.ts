import { describe, expect, test } from 'bun:test'
import { DEFAULT_CURVE, parseCurve, rpmFor } from './curve'
import { FrameParser, frame } from './protocol'

describe('curve', () => {
  const curve = parseCurve('60:2000, 40:1300,80:4000')

  test('sorts points and interpolates between them, in 100 RPM steps', () => {
    expect(curve).toEqual([
      [40, 1300],
      [60, 2000],
      [80, 4000],
    ])
    expect(rpmFor(curve, 50)).toBe(1700) // 1650 rounds up
    expect(rpmFor(curve, 70)).toBe(3000)
  })

  test('stays flat past either end', () => {
    expect(rpmFor(curve, 10)).toBe(1300)
    expect(rpmFor(curve, 120)).toBe(4000)
  })

  test('rejects bad points', () => {
    expect(() => parseCurve('40:1000')).toThrow()
    expect(() => parseCurve('40:5000')).toThrow()
    expect(() => parseCurve('40')).toThrow()
    expect(() => parseCurve('40:1300,40:2000')).toThrow()
  })

  test('default curve parses', () => {
    expect(parseCurve(DEFAULT_CURVE).length).toBeGreaterThan(1)
  })
})

describe('protocol', () => {
  test('builds the set-speed frame the firmware expects', () => {
    expect([...frame(0x21, [0x60, 0x09])]).toEqual([0x5a, 0xa5, 0x21, 0x04, 0x60, 0x09, 0x8e])
    expect(() => frame(0xdf)).toThrow()
  })

  test('parses a reply split across notifications', () => {
    const p = new FrameParser()
    expect(p.feed(Uint8Array.from([0x00, 0x5a, 0xa5, 0x21]))).toEqual([])
    const [f] = p.feed(Uint8Array.from([0x03, 0x01, 0x25]))
    expect(f.cmd).toBe(0x21)
    expect([...f.payload]).toEqual([1])
  })
})
