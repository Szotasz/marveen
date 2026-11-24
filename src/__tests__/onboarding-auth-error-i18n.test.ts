// HOSTINGERWIZERRI18N1122 (Geri 83337): the onboarding Claude step's errors are fixed-language on the server (the
// Claude branch Hungarian, the router branch English), and the wizard showed d.error as is, so an English wizard said
// "A megadott token/kulcs nem érvényes". The wizard now shows them by the response's reason in the UI language.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
const APP = read('../../web/app.js')
const ROUTE = read('../web/routes/onboarding.ts')

function lang(code: 'en' | 'hu'): Record<string, string> {
  const ctx: { window: { _i18n?: Record<string, Record<string, string>> } } = { window: {} }
  vm.runInNewContext(read(`../../web/lang/${code}.js`), ctx)
  return ctx.window._i18n![code]
}

/** The real helper out of app.js, run with a t() over one language. */
function helperFor(dict: Record<string, string>) {
  const start = APP.indexOf('const ONB_AUTH_ERR_KEYS = {')
  const end = APP.indexOf('function updateCustomModelIdRow(', start)
  expect(start).toBeGreaterThan(-1)
  const ctx: Record<string, unknown> = { t: (k: string) => dict[k] ?? `MISSING:${k}` }
  vm.runInNewContext(`${APP.slice(start, end)}\nthis.fn = onbAuthErrorText`, ctx)
  return ctx.fn as (d: unknown, router: boolean) => string
}

/** Every reason the route sends, per branch (the router branch ends where the Claude token is read). */
function routeReasons() {
  const step = ROUTE.slice(ROUTE.indexOf("if (path === '/api/onboarding/claude-auth' && method === 'POST') {"))
  const rStart = step.indexOf('if (body.routerKey !== undefined) {')
  const cStart = step.indexOf('const token = (body.token')
  const cEnd = step.indexOf("if (path === '", cStart)
  const pick = (s: string) => [...new Set([...s.matchAll(/reason: (?:token \? )?'([a-z-]+)'(?: : '([a-z-]+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)))]
  return { router: pick(step.slice(rStart, cStart)), claude: pick(step.slice(cStart, cEnd > 0 ? cEnd : undefined)) }
}

describe('onboarding Claude step: errors in the UI language (HOSTINGERWIZERRI18N1122)', () => {
  const en = helperFor(lang('en'))
  const hu = helperFor(lang('hu'))

  it('every reason the route sends has a text in both languages, per branch', () => {
    const { router, claude } = routeReasons()
    expect(claude).toEqual(expect.arrayContaining(['missing', 'bad-token', 'bad-key', 'verify-failed', 'write-failed']))
    expect(router).toEqual(expect.arrayContaining(['mixed', 'router-unavailable', 'bad-key', 'bad-model', 'write-failed']))
    for (const [branch, reasons] of [['claude', claude], ['router', router]] as const) {
      for (const reason of reasons) {
        for (const fn of [en, hu]) {
          const text = fn({ reason, error: 'SERVER TEXT' }, branch === 'router')
          expect(text, `${branch}/${reason}`).not.toMatch(/^MISSING:|SERVER TEXT/)
        }
      }
    }
  })

  it('Geri\'s case: a refused fake token reads English in an English wizard, Hungarian in a Hungarian one', () => {
    const d = { reason: 'verify-failed', error: 'A megadott token/kulcs nem érvényes (...)' }
    expect(en(d, false)).toMatch(/^The token or key is not valid/)
    expect(hu(d, false)).toMatch(/^A megadott token vagy kulcs nem érvényes/)
  })

  it('the same reason reads differently per branch (bad-key: Claude API key vs router key)', () => {
    expect(en({ reason: 'bad-key' }, false)).toContain('sk-ant-')
    expect(en({ reason: 'bad-key' }, true)).toContain('sk-hstgr-')
    // Geri's nit on #3051: the length rule is named too (checkRouterKey: 20 to 512 characters)
    expect(en({ reason: 'bad-key' }, true)).toContain('20 to 512')
    expect(hu({ reason: 'bad-key' }, true)).toContain('20-512')
  })

  it('an unknown reason keeps the server text, and nothing falls back to the generic error', () => {
    expect(en({ reason: 'something-new', error: 'server said so' }, false)).toBe('server said so')
    expect(en({}, false)).toBe(lang('en')['onboarding.error'])
  })

  it('the wizard uses the helper for this step', () => {
    expect(APP).toContain("t('onboarding.step1.owner_login_required') : onbAuthErrorText(d, router), true)")
  })
})
