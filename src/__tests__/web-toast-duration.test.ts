/**
 * showToast(msg, duration = 3000) takes MILLISECONDS as its 2nd argument. A
 * boolean there (meant as "error style", which showToast does not have) is
 * coerced by setTimeout: `true` -> 1 ms, `false` -> 0 ms, and the message
 * vanishes before anyone reads it. Found in the #1760 review (Samu) on the new
 * scope warning; the reconnect and smoke-test error toasts had carried the same
 * bug for a long time. This pins the class for every dashboard script.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = join(process.cwd(), 'web')
const scripts = readdirSync(WEB).filter(f => f.endsWith('.js'))

describe('showToast is never given a boolean as its duration', () => {
  it('the dashboard scripts were found', () => {
    expect(scripts).toContain('app.js')
  })
  it.each(scripts)('%s', (f) => {
    const src = readFileSync(join(WEB, f), 'utf8')
    const hits = src.split('\n').map((l, i) => [i + 1, l] as const).filter(([, l]) => /showToast\([^\n]*,\s*(true|false)\s*\)/.test(l))
    expect(hits).toEqual([])
  })
  it('the reconnect and smoke-test errors stay long enough to read', () => {
    const app = readFileSync(join(WEB, 'app.js'), 'utf8')
    for (const call of [
      "showToast(data.message || 'Reconnect sikertelen', 8000)",
      "showToast('Reconnect hiba', 8000)",
      "showToast(data.error || 'Smoke-test sikertelen', 8000)",
      "showToast('Smoke-test hiba', 8000)",
    ]) expect(app).toContain(call)
  })
})
