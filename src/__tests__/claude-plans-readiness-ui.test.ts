// Settings -> Claude plans readiness banner. Evaluates the real, shipped
// claudePlansReadinessLines() from web/app.js (not a copy) against the shape
// GET /api/claude-plans/readiness returns, and pins that every code the
// server can emit has localized banner text in both languages.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const SERVER = readFileSync(join(__dirname, '../web/claude-rotation-heartbeat.ts'), 'utf-8')

function extractFn(name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

const known: Record<string, string> = {
  'settings.claude_plans.readiness.main_agent_not_isolated': 'NOT ISOLATED',
}
const tStub = (key: string) => known[key] ?? key
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const lines = new Function('t', `${extractFn('claudePlansReadinessLines')}; return claudePlansReadinessLines`)(tStub) as (
  r: unknown,
) => string[] | null

describe('claudePlansReadinessLines', () => {
  it('rotation on but blocked: one line per blocker, localized when known', () => {
    expect(lines({
      ready: false,
      blockers: ['main_agent_not_isolated', 'future_code'],
      details: [{ code: 'main_agent_not_isolated', message: 'x' }, { code: 'future_code', message: 'szerver szöveg' }],
    })).toEqual(['NOT ISOLATED', 'szerver szöveg'])
  })

  it('no banner when ready, when rotation is off, or with no answer', () => {
    expect(lines({ ready: true, blockers: [], details: [] })).toBeNull()
    expect(lines({ ready: false, blockers: ['rotation_disabled', 'main_agent_not_isolated'], details: [] })).toBeNull()
    expect(lines(null)).toBeNull()
  })
})

describe('readiness i18n coverage', () => {
  const codes = [...SERVER.matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1]).filter((c) => c !== 'rotation_disabled')
  const en = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
  const hu = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')

  it('finds the server codes', () => {
    expect(codes.length).toBeGreaterThanOrEqual(4)
  })

  it.each(['en', 'hu'])('every banner code has text in %s', (lang) => {
    const src = lang === 'en' ? en : hu
    for (const code of codes) expect(src).toContain(`'settings.claude_plans.readiness.${code}':`)
    expect(src).toContain(`'settings.claude_plans.readiness.title':`)
  })
})

describe('switchToClaudePlan (manual switch / first assignment)', () => {
  function load(confirmAnswer: boolean) {
    const calls: Array<{ url: string; init: any }> = []
    const toasts: string[] = []
    let reloaded = 0
    const fetchStub = async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(
      't', 'confirm', 'fetch', 'showToast', 'loadClaudePlansList',
      `${extractFn('switchToClaudePlan')}; return switchToClaudePlan`,
    )(
      (k: string) => k,
      () => confirmAnswer,
      fetchStub,
      (m: string) => { toasts.push(m) },
      async () => { reloaded++ },
    ) as (plan: { id: string; label: string }) => Promise<void>
    return { fn, calls, toasts, reloaded: () => reloaded }
  }

  it('confirmed: POSTs the plan id as targetPlanId to the rotate route', async () => {
    const h = load(true)
    await h.fn({ id: 'claude7', label: 'Claude 7' })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe('/api/claude-plans/rotate')
    expect(h.calls[0].init.method).toBe('POST')
    expect(JSON.parse(h.calls[0].init.body)).toEqual({ targetPlanId: 'claude7' })
    expect(h.reloaded()).toBe(1)
  })

  it('declined confirm: no request at all (it restarts the main agent)', async () => {
    const h = load(false)
    await h.fn({ id: 'claude7', label: 'Claude 7' })
    expect(h.calls).toHaveLength(0)
  })

  it('the row renders the button only for a non-active, channels-allowed plan', () => {
    expect(APP).toMatch(/if \(plan\.channelsAllowed && !isActive\) \{[\s\S]{0,400}switchToClaudePlan\(plan\)/)
  })
})
