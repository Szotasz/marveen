// The owner's alerts are written with full Hungarian accents (owner rule; Samu 63941, after #2390). A guard over the
// whole owner-alert surface, so a new alert without accents fails here instead of reaching the owner's phone.
//
// What counts as owner text (and nothing else, so code, keys and ids are never flagged): the string arguments of the
// owner senders, and the string values assigned, in the same file, to a variable passed to one of them. Comments are
// skipped. A string is flagged when (a) it reads as Hungarian (at least 5 words, at least 2 unambiguous Hungarian
// words) and has no accented letter at all, or (b) it holds a word from the outgoing-copy gate's ACCENTLESS list (a
// word that cannot be spelled without its accent). English alerts pass: (a) needs Hungarian markers, (b) Hungarian words.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')

const TS_SENDERS = ['sendAlert', 'notifyOwner', 'notifyChannel', 'sendRoutineAlert', 'sendOwnerActionAlert', 'sendOwnerSlackDm', 'sendOwnerMessage', 'sendMarveenAlert']
const SH_SENDERS = ['alert_owner', 'send_alert', 'send_alarm', 'notify\\.sh"?']

/** Unambiguous Hungarian words (none of them an English word), for rule (a). */
const HU_MARKERS = new Set(['és', 'es', 'nem', 'hogy', 'van', 'kell', 'egy', 'az', 'mert', 'vagy', 'nincs', 'után', 'utan', 'már', 'mar', 'csak', 'sem', 'ez', 'még', 'majd', 'perce', 'után', 'ezt', 'ami', 'amit'])
/** Words that are correct without accents in an owner text (rule (b) never flags them). */
const VALID_UNACCENTED = new Set(['meg'])
/**
 * Deliberate exceptions, `<file>:<word or WHOLE>`, each with its reason. Empty on purpose: add one only for a text that
 * must stay as it is (for example a quoted command), never to silence a missing accent.
 */
const ALLOW = new Map<string, string>()

const ACCENTED = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
const STR = /`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/gs

function accentless(): Set<string> {
  const gate = readFileSync(join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py'), 'utf8')
  const i = gate.indexOf('ACCENTLESS = {')
  const j = gate.indexOf('\n}\n', i)
  return new Set([...gate.slice(i, j).matchAll(/"([a-z]+)": "/g)].map((m) => m[1]!))
}

function files(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '__tests__' || name === 'dist' || name.startsWith('.')) continue
    if (statSync(p).isDirectory()) files(p, ext, out)
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

/** From the '(' at k to its match, aware of quotes (and ${...} inside template literals). */
function balanced(text: string, k: number): string {
  let depth = 0
  const start = k
  while (k < text.length) {
    const c = text[k]!
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      k++
      while (k < text.length && text[k] !== q) {
        if (text[k] === '\\') k++
        k++
      }
    } else if (c === '(') depth++
    else if (c === ')') { if (--depth === 0) return text.slice(start, k + 1) }
    k++
  }
  return text.slice(start, start + 600)
}

interface Site { file: string; line: number; text: string }

function lineOf(text: string, pos: number): number { return text.slice(0, pos).split('\n').length }
function isComment(text: string, pos: number): boolean {
  const ls = text.lastIndexOf('\n', pos - 1) + 1
  return /^\s*(#|\/\/|\*)/.test(text.slice(ls, pos + 1))
}
function strings(seg: string): { at: number; s: string }[] {
  return [...seg.matchAll(STR)].map((m) => ({ at: m.index!, s: m[1] ?? m[2] ?? m[3] ?? '' }))
}

function ownerSites(): Site[] {
  const sites: Site[] = []
  const push = (file: string, text: string, pos: number, s: string) => {
    if (!isComment(text, pos)) sites.push({ file, line: lineOf(text, pos), text: s })
  }
  for (const p of files(join(ROOT, 'src'), '.ts')) {
    const text = readFileSync(p, 'utf8')
    const file = relative(ROOT, p)
    const passed = new Set<string>()
    for (const f of TS_SENDERS) {
      for (const m of text.matchAll(new RegExp(`(?<![\\w.])${f}\\(`, 'g'))) {
        if (/function\s+$/.test(text.slice(Math.max(0, m.index! - 12), m.index!))) continue
        const seg = balanced(text, m.index! + m[0].length - 1)
        for (const { at, s } of strings(seg)) push(file, text, m.index! + at, s)
        for (const v of seg.matchAll(/\(\s*([A-Za-z_]\w*)\s*[,)]/g)) passed.add(v[1]!)
      }
    }
    for (const v of passed) {
      for (const am of text.matchAll(new RegExp(`(?:const|let|var)\\s+${v}\\s*=\\s*`, 'g'))) {
        const tail = text.slice(am.index! + am[0].length, am.index! + am[0].length + 1500)
        const end = tail.search(/\n\s*(?:const|let|var|if|return|for|try|\/\/|\})/)
        for (const { at, s } of strings(tail.slice(0, end < 0 ? 600 : end))) push(file, text, am.index! + am[0].length + at, s)
      }
    }
  }
  const shFiles = [...files(join(ROOT, 'scripts'), '.sh'), join(ROOT, 'update.sh')]
  for (const p of shFiles) {
    const text = readFileSync(p, 'utf8')
    const file = relative(ROOT, p)
    const passed = new Set<string>()
    for (const f of SH_SENDERS) {
      for (const m of text.matchAll(new RegExp(`(?<![\\w-])${f}[ \\t]+(.*)`, 'g'))) {
        const arg = m[1]!
        if (/^\(\)/.test(arg)) continue
        for (const { at, s } of strings(arg)) push(file, text, m.index! + m[0].length - arg.length + at, s)
        for (const v of arg.matchAll(/\$\{?([A-Za-z_]\w*)/g)) passed.add(v[1]!)
      }
    }
    for (const v of passed) {
      for (const am of text.matchAll(new RegExp(`(?<![\\w$])${v}=`, 'g'))) {
        const rest = text.slice(am.index! + am[0].length, text.indexOf('\n', am.index!))
        for (const { at, s } of strings(rest)) push(file, text, am.index! + am[0].length + at, s)
      }
    }
  }
  return sites
}

function findings(sites: Site[], dict: Set<string>): string[] {
  const out: string[] = []
  for (const site of sites) {
    const t = site.text.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_]\w*/g, ' ')
    // A suffix after a hyphen (`1-es`, `providerű`) is not a word of its own.
    const words = [...t.matchAll(/(?<![-\w])[A-Za-zÀ-ž]+/g)].map((m) => m[0])
    const lower = words.map((w) => w.toLowerCase())
    const markers = lower.filter((w) => HU_MARKERS.has(w)).length
    if (words.length >= 5 && markers >= 2 && !ACCENTED.test(t) && !ALLOW.has(`${site.file}:WHOLE`)) {
      out.push(`${site.file}:${site.line}: a Hungarian text with no accent at all: "${site.text.slice(0, 70)}"`)
      continue
    }
    for (const w of new Set(lower)) {
      if (dict.has(w) && !VALID_UNACCENTED.has(w) && !ALLOW.has(`${site.file}:${w}`)) out.push(`${site.file}:${site.line}: "${w}" needs its accent`)
    }
  }
  return out
}

describe('owner alerts carry Hungarian accents, everywhere (the guard)', () => {
  const dict = accentless()
  const sites = ownerSites()

  it('reads the real surface: the senders are found, and the gate dictionary is loaded', () => {
    expect(dict.size).toBeGreaterThan(500)
    expect(sites.length).toBeGreaterThan(100)
    // Both kinds of source are covered: a TS sender argument and a shell variable passed to notify.sh.
    expect(sites.some((s) => s.file === join('src', 'web', 'channel-monitor.ts'))).toBe(true)
    expect(sites.some((s) => s.file === 'update.sh' && s.text.includes('Auto-update'))).toBe(true)
  })

  it('no owner alert lacks its accents', () => {
    expect(findings(sites, dict)).toEqual([])
  })

  it('the detector flags what it must and spares what it must (controls)', () => {
    const at = (text: string): Site[] => [{ file: 'x.ts', line: 1, text }]
    expect(findings(at('A gep ujraindult, ujra futok es a csatorna nem el.'), dict)).toHaveLength(1) // a whole unaccented sentence
    expect(findings(at('Kezzel kell megnezni a ${x} sort, nézd meg.'), dict).join()).toContain('"kezzel" needs its accent') // one word
    expect(findings(at('Disk space critical: the disk is at 95% and a full disk can wedge the session.'), dict)).toEqual([]) // English
    expect(findings(at('Az 1-es opcióval továbbléptettem, modellváltás nem történt.'), dict)).toEqual([]) // a suffix, accents present
    expect(findings(at('a sor meg a mezo'), dict)).toEqual([]) // short, and `meg` is a valid word
    expect(findings(at('a sor meg a tobbi'), dict).join()).toContain('"tobbi" needs its accent') // `többi` is caught even in a short text
  })
})
