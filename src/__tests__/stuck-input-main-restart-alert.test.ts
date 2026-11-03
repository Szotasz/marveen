/**
 * RESTARTFORCEUI1018: the stuck-input give-up alert told the owner to POST /api/agents/<label>/restart for every
 * session. For the MAIN agent that route is now gated (manual-restart-gate.ts), and a parked input reads as a
 * non-idle pane, so the advice answered 409. The main agent's alert names the paths that work; a sub-agent's is
 * unchanged.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parkedGiveUpAlertText, parkedGiveUpOrchestratorText } from '../web/stuck-input-watcher.js'

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

  it('sub-agent give-up goes to the main agent with its restart route', () => {
    const s = parkedGiveUpOrchestratorText('samu', 'agent-samu')
    expect(s).toContain("Agent 'samu' (tmux agent-samu)")
    expect(s).toContain('POST /api/agents/samu/restart')
  })

  it('the watcher passes whether the session is the main channels session', () => {
    const src = readFileSync(new URL('../web/stuck-input-watcher.ts', import.meta.url), 'utf-8')
    expect(src).toContain('sendAlert(parkedGiveUpAlertText(label, true))')
    expect(src).toContain("createAgentMessage('system', MAIN_AGENT_ID, parkedGiveUpOrchestratorText(label, session))")
    expect(src).not.toMatch(/sendAlert\(`[^`]*\/api\/agents\/\$\{label\}\/restart/)
  })

  it('the owner alert sits in the main-session branch, the main-agent message in its else', () => {
    // Pins the branch, not just the presence: an inverted condition would make a
    // parked main session message itself and page the owner for every sub-agent.
    const src = readFileSync(new URL('../web/stuck-input-watcher.ts', import.meta.url), 'utf-8')
    const start = src.indexOf('if (session === MAIN_CHANNELS_SESSION) {')
    expect(start).toBeGreaterThanOrEqual(0)
    const elseIdx = src.indexOf('} else {', start)
    const end = src.indexOf('}', src.indexOf('createAgentMessage(', elseIdx))
    const mainBranch = src.slice(start, elseIdx)
    const elseBranch = src.slice(elseIdx, end)
    expect(mainBranch).toContain('sendAlert(parkedGiveUpAlertText(label, true))')
    expect(mainBranch).not.toContain('createAgentMessage(')
    expect(elseBranch).toContain("createAgentMessage('system', MAIN_AGENT_ID, parkedGiveUpOrchestratorText(label, session))")
    expect(elseBranch).not.toContain('sendAlert(')
    expect(src).not.toContain('session !== MAIN_CHANNELS_SESSION')
  })
})
