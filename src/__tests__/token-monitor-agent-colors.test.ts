// Token Monitor per-agent colours (#1646). The colour code lives in the
// classic-script web/app.js, so the block is lifted out of the file and
// evaluated in isolation: a fresh instance per test, the way a page load
// starts with an empty assignment map.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

const COLORS_SRC = APP.match(/const TU_COLORS = \{[\s\S]*?\n\}\n/)![0]
const BLOCK_START = APP.indexOf('const TU_RESERVED_COLORS = [')
const BLOCK_END = APP.indexOf('\n}\n', APP.indexOf('function tuGetColor(agent) {')) + 3

type Colours = {
  TU_COLORS: Record<string, string>
  TU_RESERVED_COLORS: string[]
  TU_EXTRA_PALETTE: string[]
  tuAssignColors: (agents: string[]) => void
  tuGetColor: (agent: string) => string
}

function load(): Colours {
  const src = COLORS_SRC + APP.slice(BLOCK_START, BLOCK_END) +
    'return { TU_COLORS, TU_RESERVED_COLORS, TU_EXTRA_PALETTE, tuAssignColors, tuGetColor }'
  return new Function(src)() as Colours
}

// Agents that share a colour, as [colour, agents[]] pairs.
function collisions(colourOf: (a: string) => string, agents: string[]) {
  const by = new Map<string, string[]>()
  for (const a of agents) by.set(colourOf(a), [...(by.get(colourOf(a)) ?? []), a])
  return [...by].filter(([, as]) => as.length > 1)
}

describe('token monitor agent colours', () => {
  it('extracts the colour block from web/app.js', () => {
    expect(BLOCK_START).toBeGreaterThan(0)
    expect(BLOCK_END).toBeGreaterThan(BLOCK_START)
    expect(Object.keys(load().TU_COLORS).length).toBeGreaterThan(0)
  })

  it('palette is disjoint from every listed-agent colour and every reserved line colour', () => {
    const c = load()
    const taken = new Set([...Object.values(c.TU_COLORS), ...c.TU_RESERVED_COLORS].map((x) => x.toLowerCase()))
    expect(c.TU_EXTRA_PALETTE.filter((x) => taken.has(x.toLowerCase()))).toEqual([])
    expect(new Set(c.TU_EXTRA_PALETTE).size).toBe(c.TU_EXTRA_PALETTE.length)
    expect(c.TU_EXTRA_PALETTE.length).toBeGreaterThanOrEqual(15)
  })

  it('reserves every colour the chart draws its window lines and markers with', () => {
    const c = load()
    const reserved = new Set(c.TU_RESERVED_COLORS)
    const lineColours = [
      ...APP.matchAll(/drawCumLine\([^,]+, '(#[0-9a-f]{6})'/g),
      ...APP.matchAll(/rl\.type === '[^']+' \? '(#[0-9a-f]{6})[0-9a-f]*'/g),
      ...APP.matchAll(/: '(#[0-9a-f]{6})[0-9a-f]{2}'\n/g),
    ].map((m) => m[1])
    expect(lineColours.length).toBeGreaterThanOrEqual(4)
    expect(lineColours.filter((x) => !reserved.has(x))).toEqual([])
  })

  it('no collision after a period switch brings a listed agent in', () => {
    // The review case: 'geri' is coloured on 1h, 'codi' (listed) appears on 7d.
    const c = load()
    c.tuAssignColors(['geri', 'marveen'])
    const geri = c.tuGetColor('geri')
    c.tuAssignColors(['codi', 'geri', 'marveen'])
    expect(c.tuGetColor('geri')).toBe(geri)
    expect(collisions(c.tuGetColor, ['codi', 'geri', 'marveen'])).toEqual([])
  })

  it('no collision when every listed agent arrives after the unlisted ones', () => {
    const c = load()
    const unlisted = Array.from({ length: 12 }, (_, i) => `agent${i}`)
    c.tuAssignColors(unlisted)
    const all = [...unlisted, ...Object.keys(c.TU_COLORS)]
    c.tuAssignColors(all)
    expect(collisions(c.tuGetColor, all)).toEqual([])
  })

  it('past the palette, agents get generated distinct colours, never the grey', () => {
    const c = load()
    const agents = Array.from({ length: 24 }, (_, i) => `a${String(i).padStart(2, '0')}`)
    c.tuAssignColors(agents)
    expect(agents.filter((a) => c.tuGetColor(a) === '#64748b')).toEqual([])
    expect(collisions(c.tuGetColor, agents)).toEqual([])
  })

  it('the same agent set gets the same colours on every load', () => {
    const agents = ['zeta', 'alpha', 'marveen', 'mid']
    const a = load(); a.tuAssignColors(agents)
    const b = load(); b.tuAssignColors([...agents].reverse())
    expect(agents.map(a.tuGetColor)).toEqual(agents.map(b.tuGetColor))
  })

  it('negative control: the collision check does fire on a shared colour', () => {
    const shared = (x: string) => ({ codi: '#f59e0b', geri: '#f59e0b' } as Record<string, string>)[x]
    expect(collisions(shared, ['codi', 'geri'])).toEqual([['#f59e0b', ['codi', 'geri']]])
  })
})
