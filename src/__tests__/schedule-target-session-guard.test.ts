// OWNEREXEC1109: the scheduler types a prompt only into a fleet session. sendPromptToSession types into whatever pane
// it is given and presses Enter, without checking that Claude runs there, so a targetSession override must name the
// main channels session or a known agent's session. The real-tick case (the task is not sent, the main agent hears
// it once) is in schedule-registry-runner-tick.test.ts; this file pins the list itself.

import { describe, it, expect } from 'vitest'
import { allowedTargetSessions, targetSessionRefused, refusedTargetSessionNotice } from '../web/schedule-runner.js'
import { agentSessionName } from '../web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

const allowed = () => allowedTargetSessions(['abel', 'geri'])

describe('allowedTargetSessions: the main channels session and the known agents\' sessions, nothing else', () => {
  it('exactly the fleet', () => {
    expect([...allowed()].sort()).toEqual([MAIN_CHANNELS_SESSION, agentSessionName('abel'), agentSessionName('geri')].sort())
  })
})

describe('targetSessionRefused', () => {
  it('no override: the task goes to its own agent\'s session (not refused)', () => {
    expect(targetSessionRefused({}, allowed)).toBe(false)
    expect(targetSessionRefused({ targetSession: '' }, allowed)).toBe(false)
  })

  it('a fleet session is allowed', () => {
    expect(targetSessionRefused({ targetSession: MAIN_CHANNELS_SESSION }, allowed)).toBe(false)
    expect(targetSessionRefused({ targetSession: agentSessionName('abel') }, allowed)).toBe(false)
  })

  it.each(['plain-shell', 'work', agentSessionName('nobody'), `${MAIN_CHANNELS_SESSION}-x`, `${agentSessionName('abel')}:0`, ' '])(
    '%j is refused', (session) => {
      expect(targetSessionRefused({ targetSession: session }, allowed)).toBe(true)
    })

  it('the notice names the task, the agent and the session', () => {
    const t = refusedTargetSessionNotice('t1', 'abel', 'plain-shell')
    expect(t).toContain('"t1"')
    expect(t).toContain('abel')
    expect(t).toContain('"plain-shell"')
  })
})
