import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card 68cb6715 (i): a sub-agent's tool-permission prompt goes to the MAIN AGENT
// first (an inter-agent message; Escape only), and to the owner only when the
// same prompt still stands 15 minutes later -- from then on at the menu pass's
// own cadence. The main agent's own prompt goes to the owner, as before.
//
// The timeline below drives the REAL debounce (decidePaneErrorAlert with the
// menu pass's thresholds, pinned against channel-monitor.ts at the end) on the
// monitor's 60 s tick, so "15 minutes" is measured the way production measures
// it, not on hand-picked alert ticks.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { decidePaneErrorAlert, type PaneErrorAlertState, type PermissionPromptSummary } from '../pane-state.js'
import {
  PERM_PROMPT_OWNER_AFTER_MS,
  decidePermissionPromptEscalation,
  escalatePermissionPrompt,
  formatPermissionPromptMainAlert,
  permissionPromptSignature,
  type PermPromptEscalationState,
} from '../web/permission-prompt-escalation.js'

const MENU = { confirmMs: 45_000, dedupMs: 5 * 60 * 1000, clearMs: 2 * 60 * 1000 }
const TICK_S = 60
const T0 = 1_800_000_000_000
const SESSION = 'agent-sub'
const ASK_A: PermissionPromptSummary = { title: 'Bash command', reason: 'Dangerous rm operation on possibly-empty variable path' }
const ASK_B: PermissionPromptSummary = { title: 'Write file', reason: 'Edit a file outside the project' }

type Event = { s: number; to: 'main' | 'owner' }
type Frame = { inMenu: boolean; ask?: PermissionPromptSummary | null }

// Runs the menu pass's permission step over `minutes`. handler 'legacy' is
// today's develop behaviour, kept as the negative control: the owner is alerted
// on every alert tick, from the first one.
function run(frame: (s: number) => Frame, opts: { minutes: number; isMainAgent?: boolean; handler?: 'new' | 'legacy'; mainFails?: boolean }): Event[] {
  const states = new Map<string, PermPromptEscalationState>()
  let menu: PaneErrorAlertState = { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
  const events: Event[] = []
  for (let s = 0; s <= opts.minutes * 60; s += TICK_S) {
    const now = T0 + s * 1000
    const f = frame(s)
    const d = decidePaneErrorAlert(f.inMenu, menu, now, MENU)
    menu = d.next
    if (d.next.firstSeenAt === null) states.delete(SESSION)
    if (!d.alert || !f.inMenu) continue
    if (opts.handler === 'legacy') { events.push({ s, to: 'owner' }); continue }
    escalatePermissionPrompt(states, {
      // undefined = the default prompt; an explicit null = an unrecognised card shape
      session: SESSION, label: 'sub', isMainAgent: opts.isMainAgent ?? false, ask: f.ask === undefined ? ASK_A : f.ask, now, ownerText: 'owner text',
    }, {
      messageMainAgent: () => {
        if (opts.mainFails) throw new Error('db locked')
        events.push({ s, to: 'main' })
      },
      alertOwner: () => { events.push({ s, to: 'owner' }) },
    })
  }
  return events
}

const standing = (): Frame => ({ inMenu: true })

describe('permission prompt: main agent first, owner after 15 min (card 68cb6715)', () => {
  it('first sighting: a message to the main agent, no owner alert', () => {
    const ev = run(standing, { minutes: 5 })
    expect(ev).toEqual([{ s: 60, to: 'main' }])
  })

  it('still standing 15 min after the main agent was told: the owner is alerted, then at the 5 min cadence', () => {
    const ev = run(standing, { minutes: 25 })
    expect(ev).toEqual([
      { s: 60, to: 'main' },
      { s: 960, to: 'owner' },
      { s: 1260, to: 'owner' },
    ])
    const owner = ev.filter((e) => e.to === 'owner')
    expect(owner[0].s - 60).toBeGreaterThanOrEqual(PERM_PROMPT_OWNER_AFTER_MS / 1000)
  })

  it('resolved in between: no owner alert; the same prompt coming back later starts a new round with the main agent', () => {
    const ev = run((s) => ({ inMenu: s < 600 || s >= 1200 }), { minutes: 25 })
    expect(ev.filter((e) => e.to === 'owner')).toEqual([])
    expect(ev).toEqual([{ s: 60, to: 'main' }, { s: 1260, to: 'main' }])
  })

  it('a different prompt in the same menu spell is a new round: the main agent is told again, the clock restarts', () => {
    const ev = run((s) => ({ inMenu: true, ask: s < 480 ? ASK_A : ASK_B }), { minutes: 30 })
    expect(ev).toEqual([
      { s: 60, to: 'main' },
      { s: 660, to: 'main' },
      { s: 1560, to: 'owner' },
    ])
  })

  it('an unrecognised prompt shape (no summary) still escalates: its signature is stable', () => {
    expect(permissionPromptSignature(null)).toBe('')
    const ev = run(() => ({ inMenu: true, ask: null }), { minutes: 17 })
    expect(ev).toEqual([{ s: 60, to: 'main' }, { s: 960, to: 'owner' }])
  })

  it("the main agent's own prompt goes to the owner straight away (it cannot answer its own)", () => {
    const ev = run(standing, { minutes: 11, isMainAgent: true })
    expect(ev).toEqual([{ s: 60, to: 'owner' }, { s: 360, to: 'owner' }, { s: 660, to: 'owner' }])
  })

  it('a main-agent message that cannot be enqueued falls back to the owner at once', () => {
    const ev = run(standing, { minutes: 6, mainFails: true })
    expect(ev).toEqual([{ s: 60, to: 'owner' }, { s: 360, to: 'owner' }])
  })

  it("NEGATIVE CONTROL, today's behaviour: the owner alert goes out on the first confirmed tick", () => {
    const legacy = run(standing, { minutes: 25, handler: 'legacy' })
    expect(legacy[0]).toEqual({ s: 60, to: 'owner' })
    // ...which is exactly what the first case above rules out for the new code.
    expect(run(standing, { minutes: 25 })[0]).toEqual({ s: 60, to: 'main' })
  })
})

describe('decidePermissionPromptEscalation (pure)', () => {
  const prev: PermPromptEscalationState = { mainNotifiedAt: T0, signature: 'a' }
  it('waits inside the window, escalates at its edge', () => {
    expect(decidePermissionPromptEscalation(prev, 'a', T0 + PERM_PROMPT_OWNER_AFTER_MS - 1, { isMainAgent: false }).action).toBe('wait')
    expect(decidePermissionPromptEscalation(prev, 'a', T0 + PERM_PROMPT_OWNER_AFTER_MS, { isMainAgent: false }).action).toBe('notify-owner')
  })
  it('a stored time in the future (clock skew) restarts the round instead of holding the owner alert back', () => {
    const d = decidePermissionPromptEscalation(prev, 'a', T0 - 1000, { isMainAgent: false })
    expect(d).toEqual({ action: 'notify-main', next: { mainNotifiedAt: T0 - 1000, signature: 'a' } })
  })
})

describe('the main-agent message', () => {
  const text = formatPermissionPromptMainAlert('sub', SESSION, ASK_A)
  it('quotes the question, names the session and the 15 min owner step', () => {
    expect(text).toContain("Agent 'sub'")
    expect(text).toContain(`tmux attach -t ${SESSION}`)
    expect(text).toContain('Bash command -- Dangerous rm operation')
    expect(text).toContain('in 15 min')
  })
  it('allows Escape (= no) only, never yes', () => {
    expect(text).toContain('Escape means NO')
    expect(text).toContain('Never answer yes')
  })
})

describe('wiring in channel-monitor.ts', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
  it('the menu thresholds the timeline uses are the production ones', () => {
    expect(src).toMatch(/const MENU_RECOVER_CONFIRM_MS = 45_000\n/)
    expect(src).toMatch(/const MENU_RECOVER_DEDUP_MS = 5 \* 60 \* 1000\n/)
    expect(src).toMatch(/const MENU_RECOVER_CLEAR_MS = 2 \* 60 \* 1000\n/)
  })
  it('the permission branch escalates through escalatePermissionPrompt, and the owner text is only its ownerText', () => {
    const branch = src.slice(src.indexOf('detectsPermissionDialog(paneNow)'), src.indexOf("'Session parked in a blocking interactive menu -- sending Escape to recover'"))
    expect(branch).toMatch(/escalatePermissionPrompt\(permPromptState, \{/)
    expect(branch).toMatch(/messageMainAgent: \(text\) => \{ createAgentMessage\('system', MAIN_AGENT_ID, text\) \}/)
    expect(branch.match(/sendAlert\(/g) ?? []).toHaveLength(1)
    expect(branch).toMatch(/alertOwner: \(text, meta\) => sendAlert\(text, meta\)/)
  })
  it('the escalation state is dropped together with the menu spell', () => {
    expect(src).toMatch(/paneMenuState\.delete\(t\.session\)\n\s*permPromptState\.delete\(t\.session\)/)
  })
})
