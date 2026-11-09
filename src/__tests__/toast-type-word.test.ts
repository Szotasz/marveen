// showToast(msg, duration) took a type word ('error') from 15 callers, most of them on the Ideas page. The delay was
// then NaN, setTimeout ran the hide at once, and the toast never showed. The shipped function now falls back to the
// default duration for anything but a finite number.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const slice = (from: string) => {
  const i = APP.indexOf(from)
  const j = i < 0 ? -1 : APP.indexOf('\n}\n', i)
  return i < 0 || j < 0 ? '' : APP.slice(i, j + 2)
}
const SRC = slice('function showToast(') + slice('function toastDuration(')

function delayFor(...args: unknown[]): number {
  const delays: number[] = []
  const toast = { textContent: '', classList: { add() {}, remove() {} } }
  const setTimeout = (_fn: () => void, ms: number) => { delays.push(ms) }
  new Function('toast', 'setTimeout', 'args', `${SRC}\nshowToast(...args)`)(toast, setTimeout, args)
  return delays[0]
}

describe('a toast called with a type word still shows', () => {
  it('the functions were found', () => {
    expect(SRC).toContain('function showToast(')
    expect(SRC).toContain('function toastDuration(')
  })

  it("'error' where the duration goes means the default duration, not an instant hide", () => {
    expect(delayFor('Add meg az ötlet címét.', 'error')).toBe(3000)
  })

  it('no duration, or a number, works as before', () => {
    expect(delayFor('short')).toBe(3000)
    expect(delayFor('short', 6000)).toBe(6000)
    expect(delayFor('x'.repeat(100))).toBe(6000)
  })

  it('a non-finite number means the default too', () => {
    expect(delayFor('short', Number.NaN)).toBe(3000)
  })
})
