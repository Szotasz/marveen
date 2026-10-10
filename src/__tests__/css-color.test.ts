import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CSS_NAMED_COLORS, DEFAULT_LABEL_COLOR, MAX_CSS_COLOR_LENGTH, MAX_LABEL_PALETTE_ENTRIES, cssSplitWs, cssTrim, importedLabelColor, isHexColor, labelColorKey, normalizeCssColor, normalizeLabelColor, parseLabelPalette, reportNonColourSetting, resetReportedNonColours, resolveLabelColor,
} from '../css-color.js'
import { DEADLINE_MS, adversarialColourInputs, longWhitespaceRuns } from './helpers/css-color-adversarial.js'

// label colours from .env KANBAN_LABEL_COLORS, a
// fleet-import file and older label rows reach CSS backgrounds on the
// dashboard. One policy (normalizeCssColor), on the server and mirrored in
// web/app.js: hex kept, a CSS colour name or a strictly numeric rgb()/hsl()
// becomes hex, anything else is not a colour. The SAME vectors drive the
// dashboard mirror in app-js-html-sinks.test.ts.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { vectors } = JSON.parse(readFileSync(join(root, '__tests__', 'fixtures', 'css-color-vectors.json'), 'utf8')) as { vectors: [unknown, string | null][] }

describe('normalizeCssColor (shared vectors)', () => {
  it.each(vectors)('%j -> %j', (input, expected) => {
    expect(normalizeCssColor(input)).toBe(expected)
  })
  it('knows the full CSS named-colour table (147 names + transparent)', () => {
    expect(Object.keys(CSS_NAMED_COLORS)).toHaveLength(149)
    for (const [name, hex] of Object.entries(CSS_NAMED_COLORS)) expect(hex).toMatch(/^#[0-9a-f]{6}(00)?$/)
    expect(normalizeCssColor('constructor')).toBeNull()
    expect(normalizeCssColor('__proto__')).toBeNull()
  })
})

// the old regex trim was quadratic on a long internal
// whitespace run (rgb(1 <64k spaces> 2 3) took ~5.8 s, synchronously, on every
// /api/marveen read of such a setting). Now: a length budget before any
// parsing, and trim / split as single character scans.
describe('normalizeCssColor: bounded work', () => {
  it(`a value longer than ${MAX_CSS_COLOR_LENGTH} characters is not a colour; the boundary itself is`, () => {
    expect(MAX_CSS_COLOR_LENGTH).toBe(256)
    const at = 'rgb(1' + ' '.repeat(MAX_CSS_COLOR_LENGTH - 9) + '2 3)'
    expect(at).toHaveLength(MAX_CSS_COLOR_LENGTH)
    expect(normalizeCssColor(at)).toBe('#010203')
    expect(normalizeCssColor(at + ' ')).toBeNull()
  })
  it.each(adversarialColourInputs())('%s: null within the deadline', (_name, input) => {
    const t0 = performance.now()
    expect(normalizeCssColor(input)).toBeNull()
    expect(performance.now() - t0).toBeLessThan(DEADLINE_MS)
  })
  it('trim and split are linear on their own, without the length budget', () => {
    for (const s of longWhitespaceRuns()) {
      const t0 = performance.now()
      const t = cssTrim(s)
      const parts = cssSplitWs(t)
      expect(performance.now() - t0).toBeLessThan(DEADLINE_MS)
      expect(t.startsWith('a') && t.endsWith('b')).toBe(true)
      expect(parts).toEqual(['a', 'b'])
    }
  })
  it('trim / split keep the old regex semantics (ASCII CSS whitespace only)', () => {
    expect(cssTrim(' \t\n\r\f a b \f\r\n\t ')).toBe('a b')
    expect(cssTrim('\u00a0a\u00a0')).toBe('\u00a0a\u00a0')
    expect(cssTrim('\va\v')).toBe('\va\v')
    expect(cssTrim('   ')).toBe('')
    expect(cssSplitWs('1 \t2\n\r\f3')).toEqual(['1', '2', '3'])
    expect(cssSplitWs('1\u00a02 3')).toEqual(['1\u00a02', '3'])
  })
  it('the module keeps no regex trim / split and no unanchored pattern', () => {
    const mod = readFileSync(join(root, 'css-color.ts'), 'utf8')
    expect(mod).not.toMatch(/\.replace\(\/\^\[ \\t/)
    expect(mod).not.toMatch(/\.split\(\/\[ \\t/)
    expect(mod).not.toContain('(.*?)')
  })
})

describe('isHexColor', () => {
  it('only #rgb / #rgba / #rrggbb / #rrggbbaa', () => {
    for (const c of ['#fff', '#FFFF', '#3b82f6', '#3B82F6CC']) expect(isHexColor(c)).toBe(true)
    for (const c of ['red', 'rgb(1,2,3)', '#12345', 'url(x)', null]) expect(isHexColor(c)).toBe(false)
  })
})

describe('parseLabelPalette (KANBAN_LABEL_COLORS)', () => {
  it('an all-name palette keeps its colours, written as hex', () => {
    expect(parseLabelPalette('red,blue')).toEqual({ overflow: 0, colors: ['#ff0000', '#0000ff'], rejected: [] })
  })
  it('a mixed palette keeps every colour, in order, rgb() commas included', () => {
    expect(parseLabelPalette('red, #3b82f6 ,rgb(1,2,3), hsl(180 50% 50%),blue')).toEqual({ overflow: 0,
      colors: ['#ff0000', '#3b82f6', '#010203', '#40bfbf', '#0000ff'], rejected: [],
    })
  })
  it('drops and reports what is not a colour; all invalid -> the default', () => {
    expect(parseLabelPalette('#3b82f6, url(https://example.invalid/x) ,red;x:y')).toEqual({ overflow: 0,
      colors: ['#3b82f6'], rejected: ['url(https://example.invalid/x)', 'red;x:y'],
    })
    expect(parseLabelPalette('url(https://example.invalid/x)')).toEqual({ overflow: 0, colors: [DEFAULT_LABEL_COLOR], rejected: ['url(https://example.invalid/x)'] })
    expect(parseLabelPalette('').colors).toEqual([DEFAULT_LABEL_COLOR])
  })
  it('an unclosed ( does not swallow the later entries', () => {
    expect(parseLabelPalette('rgb(1,2,3,#fff,blue')).toEqual({ overflow: 0, colors: ['#fff', '#0000ff'], rejected: ['rgb(1', '2', '3'] })
    // an earlier, closed rgb(...) keeps its commas
    expect(parseLabelPalette('rgb(1,2,3),red,hsl(0,100%,50%,#fff')).toEqual({ overflow: 0, colors: ['#010203', '#ff0000', '#fff'], rejected: ['hsl(0', '100%', '50%'] })
  })
  it('a palette of 65 (and of 1024) colours keeps every one; the 65th is a palette member', () => {
    expect(MAX_LABEL_PALETTE_ENTRIES).toBe(1024)
    const hex = (i: number) => '#' + i.toString(16).padStart(6, '0')
    const p65 = parseLabelPalette(Array.from({ length: 65 }, (_, i) => hex(i)).join(','))
    expect(p65).toEqual({ colors: Array.from({ length: 65 }, (_, i) => hex(i)), rejected: [], overflow: 0 })
    expect(resolveLabelColor(hex(64), p65.colors)).toEqual({ color: hex(64), replaced: false })
    expect(parseLabelPalette(Array.from({ length: 1024 }, (_, i) => hex(i)).join(',')).colors).toHaveLength(1024)
  })
  it('past 1024 distinct colours the rest is COUNTED as overflow, not reported as "not a colour"', () => {
    const hex = (i: number) => '#' + i.toString(16).padStart(6, '0')
    const many = Array.from({ length: 1100 }, (_, i) => hex(i))
    const r = parseLabelPalette([...many, many[0], 'url(x)'].join(','))
    expect(r.colors).toEqual(many.slice(0, MAX_LABEL_PALETTE_ENTRIES))
    // a duplicate of a kept colour is dropped silently; an invalid entry is rejected
    expect(r.overflow).toBe(1100 - MAX_LABEL_PALETTE_ENTRIES)
    expect(r.rejected).toEqual(['url(x)'])
  })
  it('an over-long entry is rejected, and a huge palette value is parsed in bounded time', () => {
    const long = 'rgb(1' + ' '.repeat(64_000) + '2 3)'
    expect(parseLabelPalette('red,' + long + ',blue')).toEqual({ overflow: 0, colors: ['#ff0000', '#0000ff'], rejected: [long] })
    const t0 = performance.now()
    const r = parseLabelPalette('#fff,'.repeat(200_000) + 'rgb(1' + ' '.repeat(1_000_000) + '2 3)')
    expect(performance.now() - t0).toBeLessThan(4 * DEADLINE_MS)
    expect(r.colors).toEqual(['#fff'])
    expect(r.rejected).toHaveLength(1)
  })
  it('config.ts builds KANBAN_LABEL_COLORS through it and exports the rejected entries; kanban.ts reports them', () => {
    const cfg = readFileSync(join(root, 'config.ts'), 'utf8')
    expect(cfg).toMatch(/const kanbanLabelPalette = parseLabelPalette\(env\['KANBAN_LABEL_COLORS'\]/)
    expect(cfg).toContain('export const KANBAN_LABEL_COLORS = kanbanLabelPalette.colors')
    expect(cfg).toContain('export const KANBAN_LABEL_COLORS_REJECTED = kanbanLabelPalette.rejected')
    expect(cfg).toContain('export const KANBAN_LABEL_COLORS_OVERFLOW = kanbanLabelPalette.overflow')
    const kanban = readFileSync(join(root, 'web', 'routes', 'kanban.ts'), 'utf8')
    expect(kanban).toMatch(/if \(KANBAN_LABEL_COLORS_REJECTED\.length > 0\) \{\n\s*logger\.warn\(/)
    // a separate message for a palette that is too large
    expect(kanban).toMatch(/if \(KANBAN_LABEL_COLORS_OVERFLOW > 0\) \{\n\s*logger\.warn\(\{ dropped: KANBAN_LABEL_COLORS_OVERFLOW[^\n]*['`]KANBAN_LABEL_COLORS: the label palette is too large/)
  })
})

describe('normalizeLabelColor (palette, import, label POST / PUT)', () => {
  it('a colour as normalizeCssColor gives it, a var(--token) as is, anything else null', () => {
    expect(normalizeLabelColor('red')).toBe('#ff0000')
    expect(normalizeLabelColor('#3B82F6')).toBe('#3B82F6')
    expect(normalizeLabelColor(' var(--accent) ')).toBe('var(--accent)')
    for (const c of ['var(--a, url(x))', 'var(--a) red', 'var(--a);x:y', 'x;y:z var(--a)', 'var(--)', 'url(x)', 'oklch(70% 0.15 200)', 'currentColor', '', null, 42]) {
      expect(normalizeLabelColor(c)).toBeNull()
    }
  })
  it('the length budget applies to var() too', () => {
    expect(normalizeLabelColor('var(--' + 'a'.repeat(MAX_CSS_COLOR_LENGTH) + ')')).toBeNull()
  })
  it('a palette keeps var(--token) entries in order; a POST / PUT can pick one', () => {
    const p = parseLabelPalette('var(--accent), red, var(--a, red)')
    expect(p).toEqual({ overflow: 0, colors: ['var(--accent)', '#ff0000'], rejected: ['var(--a, red)'] })
    expect(resolveLabelColor('var(--accent)', p.colors)).toEqual({ color: 'var(--accent)', replaced: false })
    expect(resolveLabelColor('VAR(--accent)', p.colors)).toEqual({ color: 'var(--accent)', replaced: false })
    // a custom property name is case-sensitive: --ACCENT is another property
    expect(resolveLabelColor('var(--ACCENT)', p.colors)).toEqual({ color: 'var(--accent)', replaced: true })
    expect(resolveLabelColor('var(--other)', p.colors)).toEqual({ color: 'var(--accent)', replaced: true })
  })
})

describe('labelColorKey (case of hex vs custom property names)', () => {
  it('folds hex and the var keyword, never the property name', () => {
    expect(labelColorKey('#3B82F6')).toBe('#3b82f6')
    expect(labelColorKey('VAR(--a)')).toBe('var(--a)')
    expect(labelColorKey('var(--A)')).toBe('var(--A)')
    expect(labelColorKey('VAR(--A)')).toBe('var(--A)')
    expect(parseLabelPalette('var(--a),VAR(--A)')).toEqual({ overflow: 0, colors: ['var(--a)', 'VAR(--A)'], rejected: [] })
  })
  it('an upper-case hex palette is matched by its own spelling, lower case or rgb()', () => {
    const p = parseLabelPalette('#3B82F6,#10B981').colors
    expect(p).toEqual(['#3B82F6', '#10B981'])
    for (const req of ['#10B981', '#10b981', 'rgb(16,185,129)']) expect(resolveLabelColor(req, p)).toEqual({ color: '#10B981', replaced: false })
    expect(resolveLabelColor('#3b82f6', p)).toEqual({ color: '#3B82F6', replaced: false })
  })
  it('PUT: the stored var(--token) sent back with another keyword case keeps it, even outside the palette', () => {
    expect(resolveLabelColor('VAR(--gone)', ['#ff0000'], 'var(--gone)')).toEqual({ color: 'var(--gone)', replaced: false })
    expect(resolveLabelColor('var(--GONE)', ['#ff0000'], 'var(--gone)')).toEqual({ color: '#ff0000', replaced: true })
  })
  it('a palette with var(--a) and var(--A) keeps them distinct, and each can be picked', () => {
    const p = parseLabelPalette('var(--a),var(--A),VAR(--a)')
    expect(p).toEqual({ overflow: 0, colors: ['var(--a)', 'var(--A)'], rejected: [] })
    expect(resolveLabelColor('var(--A)', p.colors)).toEqual({ color: 'var(--A)', replaced: false })
    expect(resolveLabelColor('var(--a)', p.colors)).toEqual({ color: 'var(--a)', replaced: false })
    // a PUT from var(--a) to var(--A) switches the swatch
    expect(resolveLabelColor('var(--A)', p.colors, 'var(--a)')).toEqual({ color: 'var(--A)', replaced: false })
    // the same reference with another keyword case keeps the stored spelling
    expect(resolveLabelColor('VAR(--a)', p.colors, 'var(--a)')).toEqual({ color: 'var(--a)', replaced: false })
  })
})

describe('resolveLabelColor (label POST / PUT)', () => {
  const palette = ['#ff0000', '#3b82f6']
  const color = (...a: Parameters<typeof resolveLabelColor>) => resolveLabelColor(...a).color
  it('a palette colour in any equivalent spelling is accepted', () => {
    expect(resolveLabelColor('red', palette)).toEqual({ color: '#ff0000', replaced: false })
    expect(color('#3B82F6', palette)).toBe('#3b82f6')
    expect(color('rgb(255,0,0)', palette)).toBe('#ff0000')
    expect(color('hsl(0turn 100% 50%)', palette)).toBe('#ff0000')
  })
  it('a new colour outside the palette falls back to the first entry, flagged as replaced', () => {
    expect(resolveLabelColor('blue', palette)).toEqual({ color: '#ff0000', replaced: true })
    expect(resolveLabelColor('url(https://example.invalid/x)', palette)).toEqual({ color: '#ff0000', replaced: true })
  })
  it('INVARIANT: a PUT sending the label its own stored colour back never recolours it', () => {
    // same string, valid or not -- independent of normalizeCssColor
    expect(resolveLabelColor('blue', palette, 'blue')).toEqual({ color: 'blue', replaced: false })
    expect(color('hsl(.5turn 100% 50%)', palette, 'hsl(.5turn 100% 50%)')).toBe('hsl(.5turn 100% 50%)')
    expect(color('some-future-colour(1 2 3)', palette, 'some-future-colour(1 2 3)')).toBe('some-future-colour(1 2 3)')
    expect(color('url(x)', palette, 'url(x)')).toBe('url(x)')
    expect(color(' blue ', palette, 'blue')).toBe('blue')
    // the same colour in another spelling keeps the stored spelling
    expect(color('#FF0000', palette, 'red')).toBe('red')
    expect(color('rgb(0 0 255)', palette, 'blue')).toBe('blue')
    // also for a long full-precision stored spelling (was replaced at 64 chars)
    const precise = 'rgb(33.333333333333336% 66.66666666666667% 14.285714285714286% / 33.333333333333336%)'
    expect(resolveLabelColor('#55aa2455', ['#ff0000'], precise)).toEqual({ color: precise, replaced: false })
    expect(importedLabelColor(precise)).toEqual({ color: '#55aa2455', replaced: false })
    // a different colour is still checked against the palette
    expect(resolveLabelColor('green', palette, 'blue')).toEqual({ color: '#ff0000', replaced: true })
    expect(color('#3b82f6', palette, 'blue')).toBe('#3b82f6')
  })
  it('the kanban routes use it for POST and PUT (PUT with the current colour) and log a replacement', () => {
    const kanban = readFileSync(join(root, 'web', 'routes', 'kanban.ts'), 'utf8')
    expect(kanban).toContain('const { color: resolvedColor, replaced } = resolveLabelColor(color, KANBAN_LABEL_COLORS)')
    expect(kanban).toContain('const existing = getLabel(id)')
    expect(kanban).toContain('const resolved = resolveLabelColor(color, KANBAN_LABEL_COLORS, existing?.color)')
    expect(kanban).toMatch(/if \(replaced && color !== undefined\) logger\.warn\(/)
    expect(kanban).toMatch(/if \(resolved\.replaced && existing\) logger\.warn\(/)
  })
})

describe('reportNonColourSetting (WIP / aging / separator colours served to the dashboard)', () => {
  it('warns once per key and value for a non-colour; never for a colour or an empty value', () => {
    resetReportedNonColours()
    const warn = vi.fn()
    expect(reportNonColourSetting('KANBAN_WIP_OK_COLOR', 'url(x)', warn)).toBe('url(x)')
    reportNonColourSetting('KANBAN_WIP_OK_COLOR', 'url(x)', warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({ key: 'KANBAN_WIP_OK_COLOR', tooLong: false })
    reportNonColourSetting('KANBAN_WIP_WARN_COLOR', 'url(x)', warn)
    expect(warn).toHaveBeenCalledTimes(2)
    for (const v of ['rgb(1 2 3)', 'hsl(.5turn 100% 50%)', '#fff', 'red', '', null, undefined]) reportNonColourSetting('KANBAN_WIP_FULL_COLOR', v, warn)
    expect(warn).toHaveBeenCalledTimes(2)
  })
  it('the dedupe set is bounded: past its cap one line says so, then it is quiet', () => {
    resetReportedNonColours()
    const warn = vi.fn()
    for (let i = 0; i < 300; i++) reportNonColourSetting('K', 'url(' + i + ')', warn)
    // 256 values + one "further ones are not logged" line
    expect(warn).toHaveBeenCalledTimes(257)
    reportNonColourSetting('K', 'url(0)', warn)
    reportNonColourSetting('K', 'url(299)', warn)
    reportNonColourSetting('K', 'url(9999)', warn)
    expect(warn).toHaveBeenCalledTimes(257)
  })
  it('an over-long value is not a colour: warned once per setting, whatever its content, in bounded time', () => {
    resetReportedNonColours()
    const warn = vi.fn()
    const t0 = performance.now()
    for (let i = 0; i < 300; i++) expect(reportNonColourSetting('KANBAN_WIP_OK_COLOR', 'rgb(1' + ' '.repeat(64_000 + i) + '2 3)', warn)).toMatch(/^rgb\(1/)
    expect(performance.now() - t0).toBeLessThan(8 * DEADLINE_MS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toEqual({ key: 'KANBAN_WIP_OK_COLOR', tooLong: true })
    reportNonColourSetting('KANBAN_WIP_WARN_COLOR', '#' + 'f'.repeat(100), warn)
    expect(warn).toHaveBeenCalledTimes(2)
    // and the cap still counts them as one entry each: a short value still warns
    reportNonColourSetting('KANBAN_WIP_OK_COLOR', 'url(x)', warn)
    expect(warn).toHaveBeenCalledTimes(3)
  })
  it('a var(--token), which the dashboard keeps, is not reported', () => {
    resetReportedNonColours()
    const warn = vi.fn()
    for (const v of ['var(--accent)', ' var(--Kanban-ok) ']) reportNonColourSetting('KANBAN_WIP_OK_COLOR', v, warn)
    expect(warn).not.toHaveBeenCalled()
    reportNonColourSetting('KANBAN_WIP_OK_COLOR', 'var(--a, red)', warn)
    expect(warn).toHaveBeenCalledTimes(1)
  })
  it('marveen.ts serves all eight colour settings through it', () => {
    const src = readFileSync(join(root, 'web', 'routes', 'marveen.ts'), 'utf8')
    for (const key of ['KANBAN_AGING_WARN_COLOR', 'KANBAN_AGING_CAUTION_COLOR', 'KANBAN_AGING_CRITICAL_COLOR', 'KANBAN_WIP_OK_COLOR',
      'KANBAN_WIP_WARN_COLOR', 'KANBAN_WIP_FULL_COLOR', 'KANBAN_WIP_OVER_COLOR', 'KANBAN_SWIMLANE_SEPARATOR_COLOR']) {
      expect(src).toContain(`colourSetting('${key}')`)
      expect(src).not.toContain(`getEffectiveSettingValue('${key}')`)
    }
  })
  it('colourSetting itself reports through reportNonColourSetting and returns the setting', () => {
    const src = readFileSync(join(root, 'web', 'routes', 'marveen.ts'), 'utf8')
    const body = src.match(/function colourSetting\(key: string\): unknown \{\n([\s\S]*?)\n\}/)
    expect(body).not.toBeNull()
    expect(body![1].trim()).toBe('return reportNonColourSetting(key, getEffectiveSettingValue(key), (ctx, msg) => logger.warn(ctx, msg))')
  })
})

describe('importedLabelColor (fleet import)', () => {
  it('normalizes a legacy colour, replaces (and flags) what is not a colour', () => {
    expect(importedLabelColor('#14b8a6')).toEqual({ color: '#14b8a6', replaced: false })
    expect(importedLabelColor('red')).toEqual({ color: '#ff0000', replaced: false })
    expect(importedLabelColor('rgb(1,2,3)')).toEqual({ color: '#010203', replaced: false })
    for (const c of ['url(https://example.invalid/x)', 'red;x:y', '#12345', null, undefined]) {
      expect(importedLabelColor(c)).toEqual({ color: DEFAULT_LABEL_COLOR, replaced: true })
    }
  })
  it('keeps a var(--token), as the dashboard does; a var() with more in it is replaced', () => {
    expect(importedLabelColor('var(--accent)')).toEqual({ color: 'var(--accent)', replaced: false })
    expect(importedLabelColor(' var(--accent) ')).toEqual({ color: 'var(--accent)', replaced: false })
    for (const c of ['var(--a, url(x))', 'var(--a) red', 'var(--a);x:y', 'x;y:z var(--a)']) {
      expect(importedLabelColor(c)).toEqual({ color: DEFAULT_LABEL_COLOR, replaced: true })
    }
  })
  it('the fleet import inserts labels with it and warns on a replacement', () => {
    const src = readFileSync(join(root, 'web', 'fleet-transfer.ts'), 'utf8')
    expect(src).toContain('const imported = importedLabelColor(l.color)')
    expect(src).toMatch(/if \(imported\.replaced\) logger\.warn\(/)
    expect(src).toMatch(/\.run\(l\.id, l\.name, imported\.color, l\.created_at\)/)
  })
})
