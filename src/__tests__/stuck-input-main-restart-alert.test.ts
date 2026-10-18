/**
 * RESTARTFORCEUI1018: the stuck-input give-up alert told the owner to POST /api/agents/<label>/restart for every
 * session. For the MAIN agent that route is now gated (manual-restart-gate.ts), and a parked input reads as a
 * non-idle pane, so the advice answered 409. The main agent's alert names the paths that work; a sub-agent's is
 * unchanged.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parkedGiveUpAlertText } from '../web/stuck-input-watcher.js'

describe('parkedGiveUpAlertText', () => {
  it('main agent: the dashboard button or an explicit force, and it says the force cuts the turn', () => {
    const s = parkedGiveUpAlertText('marveen', true)
    expect(s).toContain('POST /api/marveen/restart {"force": true}')
    expect(s).toContain('dashboardon')
    expect(s).toContain('megszakítja a futó kört')
    expect(s).not.toContain('/api/agents/marveen/restart')
  })

  it('sub-agent: its own restart route, as before', () => {
    const s = parkedGiveUpAlertText('samu', false)
    expect(s).toContain('POST /api/agents/samu/restart vagy a dashboardon.')
    expect(s).not.toContain('force')
  })

  it('the watcher passes whether the session is the main channels session', () => {
    const src = readFileSync(new URL('../web/stuck-input-watcher.ts', import.meta.url), 'utf-8')
    expect(src).toContain('sendAlert(parkedGiveUpAlertText(label, session === MAIN_CHANNELS_SESSION))')
    expect(src).not.toMatch(/sendAlert\(`[^`]*\/api\/agents\/\$\{label\}\/restart/)
  })
})
