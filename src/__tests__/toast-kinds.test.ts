// The toast had one look for everything: an error read like a "saved" (Szabolcs on #2583, the type word did not
// colour anything). showToast(msg, x) now takes a kind as its second argument ('error' | 'success' | 'warn', or
// { kind, duration }), and the kind colours it. The first block marks every refusal the server gave as an error.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')
const slice = (from: string) => {
  const i = APP.indexOf(from)
  const j = i < 0 ? -1 : APP.indexOf('\n}\n', i)
  return i < 0 || j < 0 ? '' : APP.slice(i, j + 2)
}
const SRC = slice('function showToast(') + slice('function toastDuration(')
const KINDS = ['error', 'success', 'warn']

function show(...calls: unknown[][]): { classes: Set<string>; delays: number[] } {
  const classes = new Set<string>()
  const delays: number[] = []
  const toast = {
    textContent: '',
    classList: {
      add: (c: string) => { classes.add(c) },
      remove: (c: string) => { classes.delete(c) },
      toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) },
    },
  }
  const setTimeout = (_fn: () => void, ms: number) => { delays.push(ms) }
  new Function('toast', 'setTimeout', 'calls', `${SRC}\nfor (const args of calls) showToast(...args)`)(toast, setTimeout, calls)
  return { classes, delays }
}
const kindsOf = (classes: Set<string>) => [...classes].filter(c => c.startsWith('toast-')).sort()

// Every showToast(...) call in app.js with its arguments split at the top level. Quotes, template literals (with
// their ${...} parts) and nested brackets are skipped, so a comma or a paren inside a string never splits.
function calls(src: string): Array<{ line: number; args: string[]; at: number }> {
  const out: Array<{ line: number; args: string[]; at: number }> = []
  const re = /(?<![\w.])showToast\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (src.slice(Math.max(0, m.index - 9), m.index) === 'function ') continue
    let i = m.index + m[0].length
    const args: string[] = []
    let cur = ''
    const stack: string[] = [')']
    while (stack.length) {
      const c = src[i]
      const top = stack[stack.length - 1]
      if (top === '`') {
        if (c === '\\') { cur += c + src[i + 1]; i += 2; continue }
        if (c === '`') stack.pop()
        else if (c === '$' && src[i + 1] === '{') { stack.push('}'); cur += c; i++ }
        cur += src[i]; i++; continue
      }
      if (c === "'" || c === '"') {
        let k = i + 1
        while (src[k] !== c) k += src[k] === '\\' ? 2 : 1
        cur += src.slice(i, k + 1); i = k + 1; continue
      }
      if (c === '`') { stack.push('`'); cur += c; i++; continue }
      if (c === '(' || c === '[' || c === '{') stack.push(c === '(' ? ')' : c === '[' ? ']' : '}')
      else if (c === top) {
        stack.pop()
        if (!stack.length) break
      } else if (c === ',' && stack.length === 1) { args.push(cur.trim()); cur = ''; i++; continue }
      cur += c; i++
    }
    if (cur.trim()) args.push(cur.trim())
    out.push({ line: src.slice(0, m.index).split('\n').length, args, at: m.index })
  }
  return out
}
const ALL = calls(APP)
const kindArg = (args: string[]) => {
  const a = args[1] ?? ''
  const lit = a.match(/^'([a-z]+)'$/)
  if (lit) return lit[1]
  const obj = a.match(/^\{[^}]*\bkind: '([a-z]+)'[^}]*\}$/)
  return obj ? obj[1] : null
}

describe('showToast takes a kind', () => {
  it('the functions were found', () => {
    expect(SRC).toContain('function showToast(')
    expect(SRC).toContain('function toastDuration(')
  })

  it("'error', 'success' and 'warn' colour it, with the default duration", () => {
    for (const k of KINDS) {
      const r = show(['x', k])
      expect(kindsOf(r.classes)).toEqual([`toast-${k}`])
      expect(r.classes.has('visible')).toBe(true)
      expect(r.delays).toEqual([3000])
    }
  })

  it('{ kind, duration } gives both; a kind without a duration has the default', () => {
    const r = show(['x', { kind: 'error', duration: 8000 }])
    expect(kindsOf(r.classes)).toEqual(['toast-error'])
    expect(r.delays).toEqual([8000])
    expect(show(['x', { kind: 'warn' }]).delays).toEqual([3000])
  })

  it('a number, or nothing, is the neutral toast as before', () => {
    expect(kindsOf(show(['x', 6000]).classes)).toEqual([])
    expect(show(['x', 6000]).delays).toEqual([6000])
    expect(kindsOf(show(['x']).classes)).toEqual([])
  })

  it('an unknown kind is none, never a class of its own', () => {
    for (const k of ['danger', 'Error', 'visible', '']) {
      const r = show(['x', k])
      expect([...r.classes]).toEqual(['visible'])
      expect(r.delays).toEqual([3000])
    }
    expect([...show(['x', { kind: 'toast' }]).classes]).toEqual(['visible'])
  })

  it('the next toast does not keep the kind of the one before', () => {
    expect(kindsOf(show(['x', 'error'], ['y']).classes)).toEqual([])
    expect(kindsOf(show(['x', 'error'], ['y', 'success']).classes)).toEqual(['toast-success'])
  })
})

describe('the colours', () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const root = CSS.slice(CSS.indexOf(':root'), CSS.indexOf('}', CSS.indexOf(':root')))
  const resolve = (v: string) => {
    const name = v.match(/^var\((--[\w-]+)\)$/)?.[1]
    return name ? root.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? '' : v
  }

  it.each(KINDS)('.toast-%s has its own background, and white text on it is at least 4.5:1', (k) => {
    const rule = CSS.match(new RegExp(`\\.toast\\.toast-${k} \\{([^}]*)\\}`))?.[1] ?? ''
    const bg = resolve(rule.match(/background: ([^;]+);/)?.[1]?.trim() ?? '')
    expect(rule).toContain('color: #fff;')
    expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(ratio(bg, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('the dark theme leaves the three backgrounds alone (no --danger of its own), so they read the same', () => {
    const dark = CSS.slice(CSS.indexOf('[data-theme="dark"] {'), CSS.indexOf('}', CSS.indexOf('[data-theme="dark"] {')))
    expect(dark).not.toMatch(/--danger:/)
  })
})

describe('the callers', () => {
  it('the calls were found', () => {
    expect(ALL.length).toBeGreaterThan(300)
  })

  it('a kind given as a word is always one showToast knows', () => {
    const bad = ALL.filter(c => /^'[^']*'$/.test(c.args[1] ?? '') && !KINDS.includes(kindArg(c.args) ?? ''))
      .concat(ALL.filter(c => /^\{.*\bkind:/.test(c.args[1] ?? '') && !KINDS.includes(kindArg(c.args) ?? '')))
    expect(bad.map(c => `${c.line}: ${c.args[1]}`)).toEqual([])
  })

  it('every refusal from the server is an error toast (refusalReason, common.not_done)', () => {
    const refusals = ALL.filter(c => /\brefusalReason\(|'common\.not_done'/.test(c.args[0] ?? ''))
    expect(refusals.length).toBeGreaterThanOrEqual(23)
    expect(refusals.filter(c => kindArg(c.args) !== 'error').map(c => `${c.line}: ${c.args.join(', ')}`)).toEqual([])
  })

  it('a refusal thrown to the catch is an error toast there too', () => {
    const missed: string[] = []
    let n = 0
    for (let t = APP.indexOf('throw new Error(refusalReason('); t >= 0; t = APP.indexOf('throw new Error(refusalReason(', t + 1)) {
      const c = APP.indexOf('catch (', t)
      const first = ALL.find(x => x.at > c)
      n++
      if (!first || kindArg(first.args) !== 'error') missed.push(`${APP.slice(0, t).split('\n').length}: ${first?.args.join(', ')}`)
    }
    expect(n).toBeGreaterThanOrEqual(6)
    expect(missed).toEqual([])
  })
})
