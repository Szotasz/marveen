// GROMZOBRIDGEWIZARD1107 D1 follow-up (Dani 73072, Samu 73077): the route's own wiring of the main row's needsReauth.
// The helper (needsReauthOfPane) is tested in gromzo-agents.test.ts; here: the route captures the MAIN channels
// session, runs the dashboard's reauth markers on it, and a failed capture (null) stays unknown. capturePane is a
// fake: no tmux is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const captured: string[] = []
let pane: string | null = null
vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  capturePane: (session: string) => { captured.push(session); return pane },
}))
vi.mock('../logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop }
  l.child = () => l
  return { logger: l }
})

const { mainNeedsReauthNow } = await import('../web/routes/gromzo.js')
const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')

beforeEach(() => { captured.length = 0; pane = null })

describe('the route wiring of the main row\'s needsReauth', () => {
  it('captures the main channels session', () => {
    pane = 'ready'
    mainNeedsReauthNow()
    expect(captured).toEqual([MAIN_CHANNELS_SESSION])
  })
  it('no pane (no session, a failed capture) -> null, never "signed in"', () => {
    pane = null
    expect(mainNeedsReauthNow()).toBeNull()
  })
  it('the measured QA-VPS pane ("Not logged in") -> true; a normal prompt -> false', () => {
    pane = '❯ \n─────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)     Not logged in · Run /login'
    expect(mainNeedsReauthNow()).toBe(true)
    pane = '❯ \n─────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    expect(mainNeedsReauthNow()).toBe(false)
  })
  it('the default deps use it (source pin: the list row reads exactly this function)', () => {
    const src = readFileSync(new URL('../web/routes/gromzo.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/mainNeedsReauth: \(\) => mainNeedsReauthNow\(\),/)
  })
})
