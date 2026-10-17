// Colour values that come from files (.env KANBAN_LABEL_COLORS, a fleet-import
// JSON, label rows written before this check existed) end up in CSS on the
// dashboard: a swatch background, a chip's --chip-color custom property that a
// stylesheet uses as a whole `background`. There a value like
// url(https://...) or `red;position:fixed` is an active resource URL / extra
// declarations, not a colour.
//
// normalizeCssColor() is the one policy, on the server and -- mirrored
// line for line in web/app.js, checked against the same test vectors
// (src/__tests__/fixtures/css-color-vectors.json) -- in the dashboard:
//   - #rgb / #rgba / #rrggbb / #rrggbbaa      -> kept as written (trimmed)
//   - a CSS named colour (the full table)     -> its #rrggbb (transparent: #00000000)
//   - rgb() / rgba() / hsl() / hsla() with strictly numeric arguments, comma
//     or space syntax, optional alpha        -> #rrggbb, or #rrggbbaa below 1
//   - anything else (url(), var(), declarations, words, bad hex) -> null
// So a legacy `red` or `rgb(1 2 3)` keeps its colour, and nothing that is not
// a plain colour ever reaches CSS.

export const DEFAULT_LABEL_COLOR = '#64748b'

export const CSS_NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff',
  beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff',
  blueviolet: '#8a2be2', brown: '#a52a2a', burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00',
  chocolate: '#d2691e', coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b', darkgray: '#a9a9a9',
  darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b', darkmagenta: '#8b008b', darkolivegreen: '#556b2f',
  darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
  deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1e90ff',
  firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000',
  greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3', lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a', lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6',
  magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3',
  mediumpurple: '#9370db', mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23',
  orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
  paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f',
  pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
  red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072',
  sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0',
  skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090', slategrey: '#708090', snow: '#fffafa',
  springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
  tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff',
  whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32', transparent: '#00000000',
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// CSS <number>: optional sign, digits with an optional fraction or a leading
// dot, optional exponent (1e2, -1, .5, +3.25E-1); nothing else
const CSS_NUMBER = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i
const CSS_HUE_UNIT = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 } as const

const CSS_HUE_UNITS = ['grad', 'turn', 'deg', 'rad'] as const
// Input budget: a resource bound only -- the parser
// is linear -- set well above any real spelling: a full-precision JS number
// serialization like 'rgb(33.333333333333336% 66.66666666666667%
// 14.285714285714286% / 33.333333333333336%)' is 85 characters. A longer
// value is not a colour, decided BEFORE any parsing, so a file / API value of
// any size costs one length check.
export const MAX_CSS_COLOR_LENGTH = 256

// CSS whitespace is ASCII only (space, tab, LF, CR, FF): NBSP or U+3000 is
// not a separator for the browser, so it is not one here either
function isCssWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

// Trim and split are plain character scans, one pass each, no regex (a
// regex trim with an unanchored trailing whitespace run was quadratic on a
// long internal run). Every regex left in this module is
// anchored at both ends and has no nested or overlapping quantifier.
export function cssTrim(s: string): string {
  let i = 0
  let j = s.length
  while (i < j && isCssWs(s[i])) i++
  while (j > i && isCssWs(s[j - 1])) j--
  return s.slice(i, j)
}

// the tokens of a TRIMMED string separated by runs of CSS whitespace
export function cssSplitWs(s: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && !isCssWs(s[j])) j++
    out.push(s.slice(i, j))
    while (j < s.length && isCssWs(s[j])) j++
    i = j
  }
  return out
}

function hex2(n: number): string {
  // + 1e-7: a half-way channel that float arithmetic left at 127.4999999
  // rounds up like the browser's 127.5 does
  return Math.round(Math.min(255, Math.max(0, n)) + 1e-7).toString(16).padStart(2, '0')
}

function toHex(r: number, g: number, b: number, a: number): string {
  const rgb = `#${hex2(r)}${hex2(g)}${hex2(b)}`
  return a >= 1 ? rgb : rgb + hex2(Math.max(0, a) * 255)
}

// a token: a number (pct=false) or a percentage (pct=true), else null
function cssNum(token: string): { n: number; pct: boolean } | null {
  const pct = token.endsWith('%')
  const t = pct ? token.slice(0, -1) : token
  if (!CSS_NUMBER.test(t)) return null
  const n = Number(t)
  return Number.isNaN(n) ? null : { n, pct }
}

// alpha: a number or a percentage, clamped to 0..1
function cssAlpha(token: string): number | null {
  const v = cssNum(token)
  if (!v) return null
  const a = v.pct ? v.n / 100 : v.n
  return Math.min(1, Math.max(0, a))
}

// hue: a number (degrees) or a number with deg / grad / rad / turn
// (the unit is matched ASCII case-insensitively; 'grad' is tried before 'rad')
function cssHue(token: string): number | null {
  const unit = CSS_HUE_UNITS.find((u) => token.slice(-u.length).replace(/[A-Z]/g, (c) => c.toLowerCase()) === u)
  const v = cssNum(unit ? token.slice(0, -unit.length) : token)
  if (!v || v.pct) return null
  const deg = v.n * (unit ? CSS_HUE_UNIT[unit] : 1)
  return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null
}

function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
  const h = hue / 360
  const sat = Math.min(1, Math.max(0, s / 100))
  const lig = Math.min(1, Math.max(0, l / 100))
  if (sat === 0) return [lig * 255, lig * 255, lig * 255]
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat
  const p = 2 * lig - q
  const ch = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255]
}

// rgb()/rgba()/hsl()/hsla() with numeric arguments (CSS Color 4):
// - legacy comma syntax: 3 values (+ alpha); rgb channels all numbers or all
//   percentages; hsl saturation / lightness must be percentages
// - modern space syntax: 3 values (+ "/ alpha"); rgb channels may mix numbers
//   and percentages; hsl saturation / lightness numbers or percentages
// Numbers may carry a sign, a leading dot or an exponent; channels clamp to
// 0..255, alpha to 0..1, saturation / lightness to 0..100. No nested
// function, keyword (none, calc, var) or anything else is accepted.
function cssColorFunction(c: string): string | null {
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(c)
  if (!m) return null
  const fn = m[1].toLowerCase()
  const body = cssTrim(m[2])
  let parts: string[]
  let alphaToken: string | undefined
  const legacy = body.includes(',')
  if (legacy) {
    parts = body.split(',').map(cssTrim)
    if (parts.length === 4) alphaToken = parts.pop()
  } else {
    const slash = body.split('/')
    if (slash.length > 2) return null
    if (slash.length === 2) alphaToken = cssTrim(slash[1])
    parts = cssSplitWs(cssTrim(slash[0]))
  }
  if (parts.length !== 3) return null
  const a = alphaToken === undefined ? 1 : cssAlpha(alphaToken)
  if (a === null) return null
  if (fn.startsWith('rgb')) {
    const ch = parts.map(cssNum)
    if (ch.some((v) => v === null)) return null
    if (legacy && !(ch.every((v) => v!.pct) || ch.every((v) => !v!.pct))) return null
    const [r, g, b] = ch.map((v) => (v!.pct ? (v!.n * 255) / 100 : v!.n))
    return toHex(r, g, b, a)
  }
  const hue = cssHue(parts[0])
  const s = cssNum(parts[1])
  const l = cssNum(parts[2])
  if (hue === null || !s || !l) return null
  if (legacy && !(s.pct && l.pct)) return null
  const [r, g, b] = hslToRgb(hue, s.n, l.n)
  return toHex(r, g, b, a)
}

export function normalizeCssColor(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_CSS_COLOR_LENGTH) return null
  const c = cssTrim(value)
  if (HEX_COLOR.test(c)) return c
  // ASCII letters only: toLowerCase() would fold e.g. the Kelvin sign to 'k'
  const named = /^[a-z]+$/i.test(c) && Object.prototype.hasOwnProperty.call(CSS_NAMED_COLORS, c.toLowerCase()) ? CSS_NAMED_COLORS[c.toLowerCase()] : undefined
  if (named) return named
  return cssColorFunction(c)
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value.trim())
}

// Split on the commas that separate entries, not the ones inside rgb(...).
function splitTopLevelCommas(raw: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  // an unclosed '(' would swallow every later entry: from that entry on,
  // split plainly (the entries before it keep their rgb(...) commas)
  return depth === 0 ? [...out, cur] : [...out, ...cur.split(',')]
}

// A custom property reference, var(--token), and nothing else (no fallback
// argument, no second value): the dashboard's safeCssColor keeps exactly this
// shape, so the server keeps it in label colours too.
const CSS_VAR_TOKEN = /^var\(--[a-z0-9-]+\)$/i

// A label colour (palette entry, imported or requested label colour):
// normalizeCssColor's colour, or a var(--token) as is; null otherwise. The
// length budget applies to the var() form too.
export function normalizeLabelColor(value: unknown): string | null {
  const n = normalizeCssColor(value)
  if (n) return n
  if (typeof value !== 'string' || value.length > MAX_CSS_COLOR_LENGTH) return null
  const c = cssTrim(value)
  return CSS_VAR_TOKEN.test(c) ? c : null
}

// The comparison key of a normalized label colour: hex digits are
// case-insensitive, but a custom property name is case-sensitive in CSS
// (--a and --A are two properties), so only the var keyword is folded.
export function labelColorKey(c: string): string {
  return /^var\(/i.test(c) ? 'var(' + c.slice(4) : c.toLowerCase()
}

// KANBAN_LABEL_COLORS: comma-separated colours, each normalized and kept once
// (Set-based, linear); one that is not a colour (longer than
// MAX_CSS_COLOR_LENGTH included) is reported in `rejected`. Once
// MAX_LABEL_PALETTE_ENTRIES distinct colours are kept -- a resource bound far
// above any real palette -- every further colour entry is
// dropped and COUNTED in `overflow` (entries, a repeat counts again), which the
// caller reports as "palette too large", not as "not a colour". An empty
// result falls back to the default slate.
export const MAX_LABEL_PALETTE_ENTRIES = 1024
export function parseLabelPalette(raw: string): { colors: string[]; rejected: string[]; overflow: number } {
  const colors: string[] = []
  const seen = new Set<string>()
  const rejected: string[] = []
  let overflow = 0
  for (const entry of splitTopLevelCommas(raw).map((c) => c.trim()).filter(Boolean)) {
    const n = normalizeLabelColor(entry)
    if (!n) { rejected.push(entry); continue }
    const key = labelColorKey(n)
    if (seen.has(key)) continue
    if (colors.length >= MAX_LABEL_PALETTE_ENTRIES) { overflow++; continue }
    seen.add(key)
    colors.push(n)
  }
  return { colors: colors.length > 0 ? colors : [DEFAULT_LABEL_COLOR], rejected, overflow }
}

// A label colour from an imported fleet file: normalized when it is a colour
// (a name or rgb() keeps its colour, as hex) or kept when it is a
// var(--token), the default otherwise.
export function importedLabelColor(value: unknown): { color: string; replaced: boolean } {
  const n = normalizeLabelColor(value)
  return n ? { color: n, replaced: false } : { color: DEFAULT_LABEL_COLOR, replaced: true }
}

// The colour a label POST / PUT stores.
// INVARIANT: on a PUT, a request that sends the label's
// current stored colour back -- the same string, or the same normalized
// colour -- keeps it, WHETHER OR NOT normalizeCssColor understands it; a
// client resubmitting an unchanged record never recolours a label. (A stored
// value that is not a colour stays as it was; every dashboard reader passes it
// through safeCssColor.) Otherwise the requested colour when it is in the
// palette (compared normalized by labelColorKey), else the first palette
// colour -- `replaced: true` then, and the caller logs it.
export function resolveLabelColor(requested: unknown, palette: readonly string[], current?: string): { color: string; replaced: boolean } {
  const n = normalizeLabelColor(requested)
  if (typeof requested === 'string' && current !== undefined) {
    const nCurrent = normalizeLabelColor(current)
    if (requested.trim() === current.trim() || (n && nCurrent && labelColorKey(n) === labelColorKey(nCurrent))) return { color: current, replaced: false }
  }
  const hit = n ? palette.find((p) => labelColorKey(p) === labelColorKey(n)) : undefined
  return hit ? { color: hit, replaced: false } : { color: palette[0], replaced: true }
}

// A colour setting served to the dashboard (WIP, aging, swimlane separator):
// a value that is not a colour is reported once per key and value (the
// dashboard then falls back to the stylesheet colour). A var(--token) is not
// reported: the dashboard's safeCssColor keeps it. Every value longer than
// MAX_CSS_COLOR_LENGTH shares one dedupe key per setting, so the remembered
// keys stay small. Returns the value unchanged; `warn` is the caller's logger
// (this module cannot import one).
const reportedNonColours = new Set<string>()
const REPORTED_NON_COLOURS_MAX = 256
let reportedNonColoursFull = false
export function resetReportedNonColours(): void { reportedNonColours.clear(); reportedNonColoursFull = false }
export function reportNonColourSetting(key: string, value: unknown, warn: (ctx: Record<string, unknown>, msg: string) => void): unknown {
  if (typeof value !== 'string' || value.trim() === '' || normalizeCssColor(value) || CSS_VAR_TOKEN.test(value.trim())) return value
  const tooLong = value.length > MAX_CSS_COLOR_LENGTH
  const dedupeKey = tooLong ? `${key}\u0000L` : `${key}\u0000V${value}`
  if (!reportedNonColours.has(dedupeKey)) {
    // past the cap: one last line saying so, then quiet (no log flood)
    if (reportedNonColours.size >= REPORTED_NON_COLOURS_MAX) {
      if (!reportedNonColoursFull) warn({ key }, 'more non-colour colour settings than reported; further ones are not logged')
      reportedNonColoursFull = true
      return value
    }
    reportedNonColours.add(dedupeKey)
    warn({ key, tooLong }, `colour setting is not a CSS colour (hex, colour name, numeric rgb()/hsl(), var(--token), at most ${MAX_CSS_COLOR_LENGTH} characters); the dashboard shows its default instead`)
  }
  return value
}
