// A missing or unreadable security profile used to fall
// back to `default` in silence: the agent started, its settings.json was
// rewritten from the fallback, and the dashboard kept showing the REQUESTED
// name. `default` is the most permissive profile, so for any stricter profile
// the silent fallback was a permission WIDENING that nobody could see.
//
// The fallback stays; what these tests hold is that it is NAMED -- in the
// resolution, in the log, in the /security answer and on the dashboard.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILES_DIR,
  loadProfileTemplate,
  resolveProfileTemplate,
} from '../web/profiles.js'
import { logger } from '../logger.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const AGENTS_ROUTE = readFileSync(join(ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf-8')

describe('resolveProfileTemplate names a fallback', () => {
  let corrupt: string | null = null
  afterEach(() => {
    if (corrupt) rmSync(corrupt, { force: true })
    corrupt = null
    vi.restoreAllMocks()
  })

  it('an existing profile resolves to itself, with no fallback (CONTROL)', () => {
    const r = resolveProfileTemplate('researcher')
    expect([r.requested, r.effective, r.fallbackReason, r.profile.id]).toEqual([
      'researcher', 'researcher', null, 'researcher',
    ])
  })

  it('a MISSING profile falls back to default, and says so', () => {
    const r = resolveProfileTemplate('no-such-profile-x')
    expect([r.requested, r.effective, r.fallbackReason, r.profile.id]).toEqual([
      'no-such-profile-x', 'default', 'missing', 'default',
    ])
  })

  it('an UNREADABLE profile falls back to default, and says it is unreadable, not missing', () => {
    const id = `zz-corrupt-profile-${process.pid}`
    corrupt = join(PROFILES_DIR, `${id}.json`)
    writeFileSync(corrupt, '{ "id": "half a file')

    const r = resolveProfileTemplate(id)
    expect([r.effective, r.fallbackReason]).toEqual(['default', 'unreadable'])
  })

  it('loadProfileTemplate logs a WARN naming the requested and the effective profile', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)

    const profile = loadProfileTemplate('no-such-profile-x')

    expect(profile.id).toBe('default')
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, message] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string]
    expect(fields).toEqual({ requested: 'no-such-profile-x', effective: 'default', reason: 'missing' })
    expect(message).toContain('WIDEN')
  })

  it('CONTROL: loading an existing profile logs nothing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    loadProfileTemplate('developer-senior')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('every profile id the code writes exists as a template', () => {
  // The heartbeat scaffold wrote 'standard' from #257 on, a profile that never
  // existed: every heartbeat agent ran under 'default' without anyone knowing.
  it('no securityProfile literal in src names a missing template', () => {
    const existing = new Set(
      readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)),
    )
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); continue }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
        for (const m of readFileSync(full, 'utf-8').matchAll(/securityProfile:\s*'([^']+)'/g)) {
          found.push(`${full.slice(ROOT.length + 1)}: ${m[1]}`)
        }
      }
    }
    walk(join(ROOT, 'src'))

    // CONTROL: the scan reaches the heartbeat scaffold at all.
    expect(found.some(f => f.includes('heartbeat-agent-scaffold.ts'))).toBe(true)
    expect(found.filter(f => !existing.has(f.split(': ')[1]))).toEqual([])
  })
})

describe('the /security answer carries the effective profile', () => {
  it('GET /api/agents/:name/security reports effectiveProfile and fallbackReason from the resolution', () => {
    const a = AGENTS_ROUTE.indexOf("secGetMatch && method === 'GET'")
    const b = AGENTS_ROUTE.indexOf("secGetMatch && method === 'PUT'")
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    const block = AGENTS_ROUTE.slice(a, b)
    expect(block).toMatch(/const resolution = resolveProfileTemplate\(profileId\)/)
    expect(block).toMatch(/effectiveProfile: resolution\.effective/)
    expect(block).toMatch(/fallbackReason: resolution\.fallbackReason/)
  })
})

describe('the dashboard shows a requested profile that does not exist', () => {
  let hu: Record<string, string>
  let en: Record<string, string>
  beforeAll(async () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
    await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
    await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
    const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
    hu = i18n.hu
    en = i18n.en
  })

  /** Runs the real populateProfileSelect from web/app.js against a tiny fake DOM. */
  async function render(selected: string) {
    const start = APP.indexOf('function populateProfileSelect(')
    expect(APP.split('function populateProfileSelect(').length - 1).toBe(1)
    const end = APP.indexOf('\n}\n', start) + 2
    const source = APP.slice(start, end)

    type Opt = { value: string; textContent: string; selected: boolean }
    const options: Opt[] = []
    const selectEl = {
      set innerHTML(_v: string) { options.length = 0 },
      appendChild: (o: Opt) => { options.push(o) },
      prepend: (o: Opt) => { options.unshift(o) },
      get value() { return (options.find(o => o.selected) ?? options[0])?.value ?? '' },
      onchange: null as null | (() => void),
    }
    const descEl = { textContent: '' }
    const profiles = [
      { id: 'default', label: 'Alapértelmezett', description: 'Permissive fallback.', permissionMode: 'permissive' },
      { id: 'researcher', label: 'Kutató', description: 'A stricter profile.', permissionMode: 'permissive' },
    ]
    const document = { createElement: () => ({ value: '', textContent: '', selected: false }) }
    const t = (key: string, vars: Record<string, string> = {}) =>
      (hu[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '')
    let done!: () => void
    const finished = new Promise<void>(r => { done = r })
    const loadProfiles = () => ({ then: (cb: (p: typeof profiles) => void) => { cb(profiles); done() } })

    const fn = new Function('document', 't', 'loadProfiles', `${source}; return populateProfileSelect`)(
      document, t, loadProfiles,
    ) as (s: unknown, d: unknown, sel: string) => void
    fn(selectEl, descEl, selected)
    await finished
    return { options, value: selectEl.value, desc: descEl.textContent }
  }

  it('a missing requested profile is shown AS ITSELF, marked, with the consequence', async () => {
    const r = await render('standard')
    expect(r.value).toBe('standard')
    expect(r.options[0].textContent).toBe(`⚠ standard (${hu['agents.profile_missing_option']})`)
    expect(r.desc).toContain('standard')
    expect(r.desc).toBe(hu['agents.profile_missing_desc'].replace('{id}', 'standard'))
  })

  it('CONTROL: an existing profile is selected as before, with its own description and no marker', async () => {
    const r = await render('researcher')
    expect(r.value).toBe('researcher')
    expect(r.options.some(o => o.textContent.startsWith('⚠'))).toBe(false)
    expect(r.desc).toBe('A stricter profile.')
  })

  it('both languages carry the two new strings, with the {id} placeholder', () => {
    for (const bundle of [hu, en]) {
      expect(bundle['agents.profile_missing_option']).toBeTruthy()
      expect(bundle['agents.profile_missing_desc']).toContain('{id}')
    }
  })
})
