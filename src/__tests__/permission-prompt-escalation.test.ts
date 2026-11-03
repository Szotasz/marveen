import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Card 68cb6715 (i), composed with PERMFLOOD1012 (#1907): a sub-agent's
// tool-permission prompt goes to the MAIN AGENT first (an inter-agent message;
// Escape only), and to the owner only when the same prompt still stands at the
// first reminder mark (15 min by default) -- from then on at the next marks,
// not at every alert tick. The main agent's own prompt goes to the owner on
// the same marks.
//
// The timeline below drives the REAL debounce (decidePaneErrorAlert with the
// menu pass's thresholds, pinned against channel-monitor.ts at the end) on the
// monitor's 60 s tick, and the REAL pass (runPermissionPromptPass) on live pane
// captures, so "15 minutes" is measured the way production measures it, not
// on hand-picked alert ticks.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { decidePaneErrorAlert, type PaneErrorAlertState } from '../pane-state.js'
import {
  decidePermissionPromptEscalation,
  formatPermissionPromptMainAlert,
  type PermPromptEscalationState,
} from '../web/permission-prompt-escalation.js'
import { DEFAULT_PERMISSION_REMINDER_MARKS_MS, clearPermissionPromptAlert, resetPermissionPromptAlerts, runPermissionPromptPass } from '../web/permission-prompt-alert.js'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'pane', name), 'utf-8')
const MENU = { confirmMs: 45_000, dedupMs: 5 * 60 * 1000, clearMs: 2 * 60 * 1000 }
const MIN = 60 * 1000
const TICK_S = 60
const T0 = 1_800_000_000_000
const SESSION = 'agent-sub'
// Two live captures of two different prompts.
const PANE_A = fixture('permission-prompt-bash-grep.txt')
const PANE_B = fixture('permission-prompt-compound-cd.txt')
// A card the summary cannot read (its reason block cut): still a prompt.
const PANE_NO_SUMMARY = PANE_A.replace(/\n │ grep on\n[\s\S]*?running it anyway\.\n/, '')

type Event = { s: number; to: 'main' | 'owner'; text: string }
type Frame = { inMenu: boolean; pane?: string }

// Runs the menu pass's permission step over `minutes`. handler 'legacy' is
// the behaviour before card 68cb6715, kept as the negative control: the owner
// is alerted on every alert tick, from the first one.
function run(frame: (s: number) => Frame, opts: { minutes: number; isMainAgent?: boolean; handler?: 'new' | 'legacy'; mainFails?: boolean; marks?: readonly number[] }): Event[] {
  resetPermissionPromptAlerts()
  const states = new Map<string, PermPromptEscalationState>()
  let menu: PaneErrorAlertState = { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }
  const events: Event[] = []
  for (let s = 0; s <= opts.minutes * 60; s += TICK_S) {
    const now = T0 + s * 1000
    const f = frame(s)
    const d = decidePaneErrorAlert(f.inMenu, menu, now, MENU)
    menu = d.next
    // As channel-monitor does when the menu spell ends: both are dropped.
    if (d.next.firstSeenAt === null) { states.delete(SESSION); clearPermissionPromptAlert(SESSION) }
    if (!d.alert || !f.inMenu) continue
    if (opts.handler === 'legacy') { events.push({ s, to: 'owner', text: '' }); continue }
    const pane = f.pane ?? PANE_A
    runPermissionPromptPass('sub', SESSION, pane, {
      captureWithHistory: () => pane,
      escalation: states,
      isMainAgent: opts.isMainAgent ?? false,
      messageMainAgent: (text) => {
        if (opts.mainFails) throw new Error('db locked')
        events.push({ s, to: 'main', text })
      },
      send: (text) => { events.push({ s, to: 'owner', text }) },
    }, now, opts.marks ?? DEFAULT_PERMISSION_REMINDER_MARKS_MS)
  }
  return events
}
const at = (ev: Event[]) => ev.map(({ s, to }) => ({ s, to }))

beforeEach(() => resetPermissionPromptAlerts())

const standing = (): Frame => ({ inMenu: true })

describe('permission prompt: main agent first, owner at the marks from 15 min (card 68cb6715 + PERMFLOOD1012)', () => {
  it('first sighting: a message to the main agent, no owner alert', () => {
    expect(at(run(standing, { minutes: 5 }))).toEqual([{ s: 60, to: 'main' }])
  })

  it('still standing at the first mark: the owner is alerted, then at the next marks, not every 5 min', () => {
    const ev = at(run(standing, { minutes: 65 }))
    expect(ev).toEqual([
      { s: 60, to: 'main' },
      { s: 960, to: 'owner' }, // 15 min after the main agent was told
      { s: 1860, to: 'owner' }, // 30 min
      { s: 3660, to: 'owner' }, // 1 h
    ])
  })

  it('five hours unanswered: four owner messages, not one per alert tick', () => {
    const owner = at(run(standing, { minutes: 300 })).filter((e) => e.to === 'owner')
    expect(owner.map((e) => (e.s - 60) / 60)).toEqual([15, 30, 60, 120])
  })

  it('resolved in between: no owner alert; the same prompt coming back later starts a new round with the main agent', () => {
    const ev = at(run((s) => ({ inMenu: s < 600 || s >= 1200 }), { minutes: 25 }))
    expect(ev.filter((e) => e.to === 'owner')).toEqual([])
    expect(ev).toEqual([{ s: 60, to: 'main' }, { s: 1260, to: 'main' }])
  })

  it('a different prompt in the same menu spell is a new round: the main agent is told again, the clock restarts', () => {
    const ev = at(run((s) => ({ inMenu: true, pane: s < 480 ? PANE_A : PANE_B }), { minutes: 30 }))
    expect(ev).toEqual([
      { s: 60, to: 'main' },
      { s: 660, to: 'main' },
      { s: 1560, to: 'owner' },
    ])
  })

  it('a card the summary cannot read still escalates, on the header alone, and two of them are still two prompts', () => {
    const ev = run(() => ({ inMenu: true, pane: PANE_NO_SUMMARY }), { minutes: 17 })
    expect(at(ev)).toEqual([{ s: 60, to: 'main' }, { s: 960, to: 'owner' }])
    expect(ev[0].text).toContain('It asks: Bash command · from the general-purpose agent ')
    for (const e of ev) expect(e.text).not.toContain('example-wt')
    const other = PANE_B.replace(/\n │ Compound command[\s\S]*?rule exists\n/, '\n')
    const two = at(run((s) => ({ inMenu: true, pane: s < 480 ? PANE_NO_SUMMARY : other }), { minutes: 12 }))
    expect(two).toEqual([{ s: 60, to: 'main' }, { s: 660, to: 'main' }])
  })

  it("the main agent's own prompt goes to the owner on the same marks (it cannot answer its own, and every tick is the flood)", () => {
    const ev = at(run(standing, { minutes: 35, isMainAgent: true }))
    expect(ev).toEqual([{ s: 960, to: 'owner' }, { s: 1860, to: 'owner' }])
  })

  it('a main-agent message that cannot be enqueued falls back to the owner at once, then the marks', () => {
    const ev = at(run(standing, { minutes: 35, mainFails: true }))
    expect(ev).toEqual([{ s: 60, to: 'owner' }, { s: 960, to: 'owner' }, { s: 1860, to: 'owner' }])
  })

  it('a first mark of 0 tells both at first sight', () => {
    const ev = run(standing, { minutes: 6, marks: [0, 30 * MIN] })
    expect(at(ev)).toEqual([{ s: 60, to: 'main' }, { s: 60, to: 'owner' }])
    expect(ev[0].text).toContain('The owner gets the alert as well.')
  })

  it('the owner text says what is asked and when the next message comes', () => {
    const owner = run(standing, { minutes: 16 }).filter((e) => e.to === 'owner')
    expect(owner[0].text).toContain('Ezt kérdezi: „Bash command · from the general-purpose agent -- grep on')
    expect(owner[0].text).toContain('15 perce vár válaszra. Ha nem kap választ, 15 perc múlva szólok újra.')
  })

  it("NEGATIVE CONTROL, the behaviour before card 68cb6715: the owner alert goes out on the first confirmed tick", () => {
    const legacy = run(standing, { minutes: 25, handler: 'legacy' })
    expect(at(legacy)[0]).toEqual({ s: 60, to: 'owner' })
    // ...which is exactly what the first case above rules out for the new code.
    expect(at(run(standing, { minutes: 25 }))[0]).toEqual({ s: 60, to: 'main' })
  })
})

describe('decidePermissionPromptEscalation (pure)', () => {
  const prev: PermPromptEscalationState = { mainNotifiedAt: T0, signature: 'a' }
  it('the same prompt is not a new round, a different one is', () => {
    expect(decidePermissionPromptEscalation(prev, 'a', T0 + 60 * MIN, { isMainAgent: false })).toEqual({ notifyMain: false, next: prev })
    expect(decidePermissionPromptEscalation(prev, 'b', T0 + MIN, { isMainAgent: false })).toEqual({ notifyMain: true, next: { mainNotifiedAt: T0 + MIN, signature: 'b' } })
  })
  it('a stored time in the future (clock skew) restarts the round', () => {
    const d = decidePermissionPromptEscalation(prev, 'a', T0 - 1000, { isMainAgent: false })
    expect(d).toEqual({ notifyMain: true, next: { mainNotifiedAt: T0 - 1000, signature: 'a' } })
  })
  it("the main agent's own pane never tells the main agent", () => {
    expect(decidePermissionPromptEscalation(null, 'a', T0, { isMainAgent: true })).toEqual({ notifyMain: false, next: null })
  })
})

describe('the main-agent message', () => {
  const text = formatPermissionPromptMainAlert('sub', SESSION, 'Bash command -- Dangerous rm operation on possibly-empty variable path', 15 * MIN)
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
  it('the permission branch escalates through runPermissionPromptPass, with the main agent and the owner sinks', () => {
    const branch = src.slice(src.indexOf('detectsPermissionDialog(paneNow)'), src.indexOf("'Session parked in a blocking interactive menu -- sending Escape to recover'"))
    expect(branch).toMatch(/runPermissionPromptPass\(label, t\.session, paneNow, \{/)
    expect(branch).toMatch(/escalation: permPromptState,/)
    expect(branch).toMatch(/isMainAgent: t\.isMarveen,/)
    expect(branch).toMatch(/messageMainAgent: \(text\) => \{ createAgentMessage\('system', MAIN_AGENT_ID, text\) \}/)
    expect(branch.match(/sendAlert\(/g) ?? []).toHaveLength(1)
    expect(branch).toMatch(/send: \(text, meta\) => sendAlert\(text, meta\)/)
  })
  it('the escalation state is dropped together with the menu spell', () => {
    expect(src).toMatch(/paneMenuState\.delete\(t\.session\)\n\s*permPromptState\.delete\(t\.session\)/)
  })
})
