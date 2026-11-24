// MIOAGENTB4-1122: the dashboard's Agent catalog page (web/app.js), its pure parts run out of the real source.
// The error texts follow the #3051 pattern: every error code the agent-package routes and remote.ts can send has a
// text in both languages. The picture rule and the text-only rule are Samu's extras 1 and 2 on the plan review.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
const APP = read('../../web/app.js')
const BLOCK_START = '// ===================== MIOAGENTB4-1122: Agent catalog'
const BLOCK = APP.slice(APP.indexOf(BLOCK_START), APP.indexOf('function updateCustomModelIdRow(', APP.indexOf(BLOCK_START)))

function lang(code: 'en' | 'hu'): Record<string, string> {
  const ctx: { window: { _i18n?: Record<string, Record<string, string>> } } = { window: {} }
  vm.runInNewContext(read(`../../web/lang/${code}.js`), ctx)
  return ctx.window._i18n![code]
}

type Fns = {
  agentPkgErrorText: (d: unknown) => string
  agentPkgErrorStep: (d: unknown) => number
  agentPkgAvatarUrl: (raw: unknown, origin: unknown) => string | null
  agentPkgCardState: (pkg: Record<string, unknown>, view: Record<string, unknown>, installed: Record<string, unknown>) => Record<string, unknown>
  agentPkgFileRows: (pkg: Record<string, unknown>) => Array<[string, string]>
  AGENT_PKG_ERR_KEYS: Record<string, string>
}
function load(dict: Record<string, string>): Fns {
  const t = (k: string, p?: Record<string, unknown>) => {
    const s = dict[k]
    if (s === undefined) return `MISSING:${k}`
    return s.replace(/\{(\w+)\}/g, (_m, n) => String(p?.[n] ?? ''))
  }
  const ctx: Record<string, unknown> = { t, ownerSessionText: (b: { code?: string } | null) => (b && b.code === 'owner_session_required' ? 'OWNER' : ''), URL }
  vm.runInNewContext(`${BLOCK}\nthis.f = { agentPkgErrorText, agentPkgErrorStep, agentPkgAvatarUrl, agentPkgCardState, agentPkgFileRows, AGENT_PKG_ERR_KEYS }`, ctx)
  return ctx.f as Fns
}

/** Every `error: '<code>'` the route and the network module can answer with. */
function serverCodes(): string[] {
  const src = read('../web/routes/agent-packages.ts') + read('../web/agent-package/remote.ts')
  return [...new Set([...src.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]))]
}

describe('Agent catalog page: error texts (MIOAGENTB4-1122, the #3051 pattern)', () => {
  const en = load(lang('en'))
  const hu = load(lang('hu'))

  it('every error code the server can send has its own text in both languages', () => {
    const codes = serverCodes()
    expect(codes).toEqual(expect.arrayContaining(['unknown_kid', 'not_entitled', 'package_rejected', 'invalid_code', 'token_limit', 'install_failed']))
    for (const code of codes) {
      expect(en.AGENT_PKG_ERR_KEYS[code], code).toBeTruthy()
      for (const f of [en, hu]) {
        const text = f.agentPkgErrorText({ error: code })
        expect(text, code).not.toMatch(/^MISSING:/)
        expect(text, code).not.toBe(code)
      }
    }
  })

  it('an unknown code keeps the server text; the owner refusal goes through ownerSessionText', () => {
    expect(en.agentPkgErrorText({ error: 'model not launchable by the installed Claude Code CLI' })).toBe('model not launchable by the installed Claude Code CLI')
    expect(en.agentPkgErrorText({})).toBe(lang('en')['agentCatalog.err.generic'])
    expect(en.agentPkgErrorText({ error: 'forbidden', code: 'owner_session_required' })).toBe('OWNER')
  })

  it('the same code reads in the UI language', () => {
    expect(en.agentPkgErrorText({ error: 'unknown_kid' })).toMatch(/^Your Marveen cannot verify/)
    expect(hu.agentPkgErrorText({ error: 'unknown_kid' })).toMatch(/^Ezt az ügynököt a Marveened/)
  })

  it('the failed install step comes from the code (a package_rejected splits by its verifier step)', () => {
    expect(en.agentPkgErrorStep({ error: 'not_entitled' })).toBe(1)
    expect(en.agentPkgErrorStep({ error: 'download_failed' })).toBe(1)
    expect(en.agentPkgErrorStep({ error: 'unknown_kid' })).toBe(2)
    expect(en.agentPkgErrorStep({ error: 'package_rejected', step: 1 })).toBe(2)
    expect(en.agentPkgErrorStep({ error: 'package_rejected', step: 5 })).toBe(3)
    expect(en.agentPkgErrorStep({ error: 'name_taken' })).toBe(4)
    expect(en.agentPkgErrorStep({ error: 'model not launchable' })).toBe(4)
  })
})

describe('the package picture: https from the publishing origin only (Samu, extra 1)', () => {
  const f = load(lang('en'))
  const O = 'https://packages.example'
  it.each([
    ['https://packages.example/a/b.png', 'https://packages.example/a/b.png'],
    ['http://packages.example/a.png', null],
    ['https://evil.example/a.png', null],
    ['https://packages.example.evil.example/a.png', null],
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AAAA', null],
    ['//packages.example/a.png', null],
    ['not a url', null],
    [42, null],
  ])('%s -> %s', (raw, out) => {
    expect(f.agentPkgAvatarUrl(raw, O)).toBe(out)
  })
  it('https is required on its own, even if an origin were ever http', () => {
    expect(f.agentPkgAvatarUrl('http://packages.example/a.png', 'http://packages.example')).toBe(null)
  })
  it('no origin (the installer asleep): never a picture', () => {
    expect(f.agentPkgAvatarUrl('https://packages.example/a.png', null)).toBe(null)
    expect(f.agentPkgAvatarUrl('https://packages.example/a.png', '')).toBe(null)
  })
})

describe('the card state (plan 3.3)', () => {
  const f = load(lang('en'))
  const pkg = { slug: 'meeting-memo', version: '1.1.0', min_marveen_version: '1.50.0', kid: 'k1' }
  const view = (catalog: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ catalog, knownKids: ['k1'], marveenVersion: '1.51.2', ...over })
  const kind = (p: Record<string, unknown>, v: Record<string, unknown>, inst: Record<string, unknown> = {}) => f.agentPkgCardState(p, v, inst).kind

  it.each([
    ['full', { access: 'full', trial_pick: null }, 'install'],
    ['trial, no pick', { access: 'trial', trial_pick: null }, 'install'],
    ['trial, this pick', { access: 'trial', trial_pick: 'meeting-memo' }, 'install'],
    ['trial, another pick', { access: 'trial', trial_pick: 'video-cut' }, 'locked_trial'],
    ['free', { access: 'none', trial_pick: null }, 'locked_free'],
    ['an unknown access', { access: 'gold', trial_pick: null }, 'locked_free'],
  ])('%s -> %s', (_l, cat, want) => {
    expect(kind(pkg, view(cat))).toBe(want)
  })

  it('only the trial with no pick yet asks for the trial confirmation', () => {
    expect(f.agentPkgCardState(pkg, view({ access: 'trial', trial_pick: null }), {}).trialPick).toBe(true)
    expect(f.agentPkgCardState(pkg, view({ access: 'trial', trial_pick: 'meeting-memo' }), {}).trialPick).toBe(false)
    expect(f.agentPkgCardState(pkg, view({ access: 'full', trial_pick: null }), {}).trialPick).toBe(false)
  })

  it('a minimum above this Marveen, an unknown kid or no kid: locked before any download', () => {
    const full = { access: 'full', trial_pick: null }
    expect(kind({ ...pkg, min_marveen_version: '1.52.0' }, view(full))).toBe('locked_old')
    expect(kind({ ...pkg, kid: 'k2' }, view(full))).toBe('locked_old')
    expect(kind({ ...pkg, kid: undefined }, view(full))).toBe('locked_old')
    expect(kind(pkg, view(full, { knownKids: [] }))).toBe('locked_old')
  })

  it('installed wins over the account; a higher catalog version is an update', () => {
    const free = { access: 'none', trial_pick: null }
    expect(kind(pkg, view(free), { 'meeting-memo': { name: 'meeting-memo', version: '1.1.0', running: true } })).toBe('installed')
    expect(kind(pkg, view(free), { 'meeting-memo': { name: 'meeting-memo', version: '1.0.0', running: true } })).toBe('update')
  })
})

describe('the file list before the install (D3)', () => {
  const f = load(lang('en'))
  it('from files[] when the catalog gives it (D3/A): counted per skill', () => {
    const rows = f.agentPkgFileRows({ files: ['CLAUDE.md', 'SOUL.md', 'skills/a/SKILL.md', 'skills/a/references/x.md', 'skills/b/SKILL.md'], skills: ['a', 'b'] })
    expect(rows.map((r) => r[0])).toEqual(['PACKAGE.md', 'SOUL.md', 'skills/a/', 'skills/b/'])
    expect(rows[2][1]).toBe('2 files')
  })
  it('from skills[] otherwise (D3/B)', () => {
    expect(f.agentPkgFileRows({ skills: ['a', 7, 'b'] }).map((r) => r[0])).toEqual(['PACKAGE.md', 'SOUL.md', 'skills/a/', 'skills/b/'])
  })
})

describe('catalog fields reach the DOM as text only (plan 6.5, T4; Samu, extra 2)', () => {
  it('the page block writes no HTML: no innerHTML, no insertAdjacentHTML, no outerHTML', () => {
    expect(BLOCK.length).toBeGreaterThan(1000)
    expect(BLOCK).not.toMatch(/\.innerHTML\b|insertAdjacentHTML|\.outerHTML\b|document\.write/)
  })
  it('its one element builder sets textContent', () => {
    expect(BLOCK).toContain('if (text !== undefined && text !== null) e.textContent = String(text)')
  })
})
