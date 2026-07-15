import { describe, it, expect } from 'vitest'
import {
  isQuietHour,
  localHour,
  routeEscalation,
  flushQuietSummary,
  buildQuietSummaryMessage,
  buildEscalationMessage,
  type QuietSuppressedEntry,
} from '../web/reauth-healer.js'
import { APP_TZ } from '../config.js'

// Quiet hours (23:00-06:00 in the install zone, APP_TZ) for the reauth-healer escalation.
// Motivated by 2026-07-09 night: spock+scotty re-alerted every 30 minutes all
// night about a dead token nobody could fix before morning. The probe keeps
// running; ONLY notify.sh is held back, and the first sweep after 06:00 sends
// ONE summary about the agents still dead at that moment.

const entry = (session: string, label = session, consecutiveDead = 10): QuietSuppressedEntry => ({
  session,
  label,
  reason: 'API Error: 401',
  consecutiveDead,
})

describe('isQuietHour / localHour', () => {
  it('23:00-05:59 csendes, 06:00-22:59 nem', () => {
    expect(isQuietHour(23)).toBe(true)
    expect(isQuietHour(0)).toBe(true)
    expect(isQuietHour(5)).toBe(true)
    expect(isQuietHour(6)).toBe(false)
    expect(isQuietHour(12)).toBe(false)
    expect(isQuietHour(22)).toBe(false)
  })

  it('localHour a host TZ-től függetlenül az install-zóna (APP_TZ) óráját adja', () => {
    // TZ-agnostic: localHour must equal an independent hour extraction in APP_TZ,
    // whatever APP_TZ is (Europe/London on this install). No hardcoded zone -> a
    // future SCHEDULER_TZ change does not break this test.
    const hourIn = (ms: number) =>
      parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', hour12: false }).format(new Date(ms)), 10)
    for (const ms of [Date.UTC(2026, 6, 9, 22, 30), Date.UTC(2026, 6, 10, 4, 5), Date.UTC(2026, 0, 10, 22, 30)]) {
      expect(localHour(ms)).toBe(hourIn(ms))
    }
  })
})

describe('routeEscalation', () => {
  it('nappal azonnal notify-ol, nem gyűjt', () => {
    const sent: string[] = []
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry('agent-spock', 'spock'), false, (m) => sent.push(m), suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('spock')
    expect(suppressed.size).toBe(0)
  })

  it('csendes sávban NINCS notify, a riasztás a reggeli összegzőre vár', () => {
    const sent: string[] = []
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry('agent-spock', 'spock'), true, (m) => sent.push(m), suppressed)
    routeEscalation(entry('agent-scotty', 'scotty'), true, (m) => sent.push(m), suppressed)
    expect(sent).toHaveLength(0)
    expect([...suppressed.keys()]).toEqual(['agent-spock', 'agent-scotty'])
  })

  it('ismételt éjszakai eszkaláció felülírja a bejegyzést, nem duplikál', () => {
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry('agent-spock', 'spock', 10), true, () => {}, suppressed)
    routeEscalation(entry('agent-spock', 'spock', 20), true, () => {}, suppressed)
    expect(suppressed.size).toBe(1)
    expect(suppressed.get('agent-spock')?.consecutiveDead).toBe(20)
  })
})

describe('flushQuietSummary', () => {
  it('csendes sáv alatt no-op (a gyűjtő érintetlen marad)', () => {
    const sent: string[] = []
    const suppressed = new Map([['agent-spock', entry('agent-spock', 'spock')]])
    flushQuietSummary(true, () => 10, (m) => sent.push(m), () => {}, suppressed)
    expect(sent).toHaveLength(0)
    expect(suppressed.size).toBe(1)
  })

  it('06:00 után EGY összegző megy ki a még mindig halott agensekről, cooldown-stampeléssel', () => {
    const sent: string[] = []
    const stamped: string[] = []
    const suppressed = new Map([
      ['agent-spock', entry('agent-spock', 'spock', 50)],
      ['agent-scotty', entry('agent-scotty', 'scotty', 40)],
    ])
    const stillDead = (s: string) => (s === 'agent-spock' ? 120 : s === 'agent-scotty' ? 110 : 0)
    flushQuietSummary(false, stillDead, (m) => sent.push(m), (s) => stamped.push(s), suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('spock')
    expect(sent[0]).toContain('scotty')
    expect(sent[0]).toContain('Reggeli token-összegzés')
    expect(stamped.sort()).toEqual(['agent-scotty', 'agent-spock'])
    expect(suppressed.size).toBe(0)
  })

  it('reggelre meggyógyult agent kimarad; ha mind meggyógyult, nincs üzenet', () => {
    const sent: string[] = []
    const suppressed = new Map([
      ['agent-spock', entry('agent-spock', 'spock')],
      ['agent-scotty', entry('agent-scotty', 'scotty')],
    ])
    flushQuietSummary(false, (s) => (s === 'agent-spock' ? 99 : 0), (m) => sent.push(m), () => {}, suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('spock')
    expect(sent[0]).not.toContain('scotty')

    const sent2: string[] = []
    const allHealed = new Map([['agent-data', entry('agent-data', 'data')]])
    flushQuietSummary(false, () => 0, (m) => sent2.push(m), () => {}, allHealed)
    expect(sent2).toHaveLength(0)
    expect(allHealed.size).toBe(0)
  })
})

describe('éjszaka -> reggel szimuláció (a 2026-07-09-es spock+scotty eset)', () => {
  it('23:10-től 05:40-ig 14 eszkaláció-tick alatt NULLA notify, 06:0x-kor pontosan EGY összegző', () => {
    const sent: string[] = []
    const suppressed = new Map<string, QuietSuppressedEntry>()
    const notify = (m: string) => sent.push(m)

    // Night: the healer's 30-min cooldown fires ~14 escalation decisions
    // across two agents between 23:10 and 05:40 -- all routed during quiet.
    for (let i = 0; i < 7; i++) {
      routeEscalation(entry('agent-spock', 'spock', 10 + i * 10), true, notify, suppressed)
      routeEscalation(entry('agent-scotty', 'scotty', 10 + i * 10), true, notify, suppressed)
      // Mid-night sweeps with nothing to flush stay silent too.
      flushQuietSummary(true, () => 999, notify, () => {}, suppressed)
    }
    expect(sent).toHaveLength(0)

    // 06:0x, first non-quiet sweep: both still dead -> one summary, then the
    // suppression buffer is empty so later sweeps send nothing extra.
    const stamped: string[] = []
    flushQuietSummary(false, () => 130, notify, (s) => stamped.push(s), suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0].split('\n').filter((l) => l.startsWith('•'))).toHaveLength(2)
    expect(stamped).toHaveLength(2)
    flushQuietSummary(false, () => 130, notify, () => {}, suppressed)
    expect(sent).toHaveLength(1)
  })
})

describe('üzenet-szövegek', () => {
  it('az egyedi eszkaláció szövege változatlan formátumú', () => {
    const msg = buildEscalationMessage('spock', 'API Error: 401', 3)
    expect(msg).toContain('spock')
    expect(msg).toContain('API Error: 401')
    expect(msg).toContain('Manuális browser /login')
  })

  it('az összegző megnevezi a sávot és agensenként a hozzávetőleges időt', () => {
    const msg = buildQuietSummaryMessage([entry('agent-spock', 'spock', 140)])
    expect(msg).toContain('23:00-06:00')
    expect(msg).toContain('• spock')
    expect(msg).toMatch(/~\d+ perce/)
  })
})
