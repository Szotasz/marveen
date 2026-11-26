import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readQuotaNoticeConfig, readUsageCollectSnapshot, fresherSnapshot, decideThresholdNotices, formatThresholdNotice,
  scanChannelExchanges, unansweredInbound, wallStateFor, decideAutoReplies, decideHandBacks, runQuotaNoticeTick,
  bannerTimeFor, formatAutoReply, planStateSnapshot, snapshotOfPlan, loadQuotaNoticeState, DEFAULT_PLAN_ID,
  type PlanQuota,
  type QuotaNoticeDeps, type QuotaNoticeState,
} from '../web/quota-notice.js'
import type { QuotaSnapshot } from '../web/quota.js'

const NOW = 1_795_700_000 // unix seconds
const snap = (five: number, seven: number, fiveReset = NOW + 3600, sevenReset = NOW + 86400 * 3): QuotaSnapshot => ({
  status: 'ok', ageSec: 60, maxAgeSec: 2700,
  fiveHour: { usedPercentage: five, resetsAt: fiveReset, expired: false },
  sevenDay: { usedPercentage: seven, resetsAt: sevenReset, expired: false },
})

describe('config', () => {
  it('defaults: BOTH parts off, 90 / 95, grace 120', () => {
    expect(readQuotaNoticeConfig(() => undefined, {})).toEqual({ noticeEnabled: false, noticePct: 90, autoReplyEnabled: false, autoReplyPct: 95, autoReplyGraceSec: 120, dryRun: false })
  })
  it('reads the settings values, rejects nonsense percentages; dry-run is environment only', () => {
    const v: Record<string, string | number> = { QUOTA_NOTICE: '1', QUOTA_NOTICE_PCT: 80, QUOTA_AUTOREPLY: '1', QUOTA_AUTOREPLY_PCT: 150 }
    const c = readQuotaNoticeConfig((k) => v[k], { QUOTA_NOTICE_DRY_RUN: '1' })
    expect(c).toMatchObject({ noticeEnabled: true, noticePct: 80, autoReplyEnabled: true, autoReplyPct: 95, dryRun: true })
  })
})

describe('usage-collect snapshot', () => {
  it('maps claude.windows and measures freshness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qn-'))
    const f = join(dir, 'usage-latest.json')
    writeFileSync(f, JSON.stringify({ claude: { ok: true, measured_at: new Date((NOW - 100) * 1000).toISOString(), windows: { five_hour: { used_percent: 91, resets_at: NOW + 60 }, seven_day: { used_percent: 40, resets_at: NOW + 999 } } } }))
    const s = readUsageCollectSnapshot(f, NOW)
    expect(s.status).toBe('ok')
    expect(s.fiveHour?.usedPercentage).toBe(91)
    expect(readUsageCollectSnapshot(f, NOW + 10_000).status).toBe('stale')
    expect(readUsageCollectSnapshot(join(dir, 'nope.json'), NOW).status).toBe('missing')
  })
  it('a fresh reading beats a stale one', () => {
    const stale = { ...snap(10, 10), status: 'stale' as const }
    expect(fresherSnapshot(stale, snap(50, 50)).fiveHour?.usedPercentage).toBe(50)
  })
})

describe('(A) threshold notice', () => {
  it('fires once per window and re-arms on the next window', () => {
    const first = decideThresholdNotices(snap(91, 30), {}, 90)
    expect(first.notices.map((n) => n.kind)).toEqual(['five_hour'])
    const again = decideThresholdNotices(snap(97, 30), first.next, 90)
    expect(again.notices).toEqual([])
    const nextWindow = decideThresholdNotices(snap(92, 30, NOW + 20000), first.next, 90)
    expect(nextWindow.notices.map((n) => n.kind)).toEqual(['five_hour'])
  })
  it('both windows, highest first; nothing under the threshold or on a stale reading', () => {
    expect(decideThresholdNotices(snap(93, 95), {}, 90).notices.map((n) => n.kind)).toEqual(['seven_day', 'five_hour'])
    expect(decideThresholdNotices(snap(89, 10), {}, 90).notices).toEqual([])
    expect(decideThresholdNotices({ ...snap(99, 99), status: 'stale' }, {}, 90).notices).toEqual([])
  })
  it('Hungarian text: names the subscription, accents, percentage, no em dash', () => {
    const t = formatThresholdNotice({ kind: 'five_hour', pct: 90.4, resetsAt: NOW + 3600, planLabel: 'Céges' }, 'hu', NOW)
    expect(t).toContain('„Céges” előfizetés')
    expect(t).toContain('90%')
    expect(t).toContain('5 órás')
    expect(t).not.toMatch(/—|–/)
  })
})

const tl = (o: unknown) => JSON.stringify(o)
const inboundLine = (chat: string, mid: string, atIso: string, text = 'szia') => tl({
  type: 'user', timestamp: atIso,
  message: { content: `<channel source="plugin:discord:discord" chat_id="${chat}" message_id="${mid}" user="dave" ts="${atIso}">\n${text}\n</channel>` },
})
const replyLine = (chat: string, atIso: string) => tl({
  type: 'assistant', timestamp: atIso,
  message: { content: [{ type: 'tool_use', name: 'mcp__plugin_discord_discord__reply', input: { chat_id: chat, text: 'ok' } }] },
})
const iso = (sec: number) => new Date(sec * 1000).toISOString()

describe('(B) transcript scan', () => {
  it('finds unanswered inbound per chat after the grace period', () => {
    const ex = scanChannelExchanges([
      inboundLine('A', '1', iso(NOW - 600)), replyLine('A', iso(NOW - 590)),
      inboundLine('B', '2', iso(NOW - 300), 'hello'),
      inboundLine('C', '3', iso(NOW - 10)),
      'not json', tl({ type: 'user', timestamp: iso(NOW), message: { content: [{ type: 'tool_result', content: '<channel source="plugin:x" chat_id="Z">' }] } }),
    ])
    expect(ex.inbound.map((i) => i.chatId)).toEqual(['A', 'B', 'C'])
    const open = unansweredInbound(ex, NOW * 1000, 120_000)
    expect(open.map((i) => i.chatId)).toEqual(['B'])
    expect(open[0].text).toBe('hello')
  })
})

describe('(B) transcript scan, busy session', () => {
  it('reads a message queued mid-turn (queue-operation + queued_command) once, at its envelope time', () => {
    const tag = `<channel source="plugin:discord:discord" chat_id="Q" message_id="7" user="dave" ts="${iso(NOW - 400)}">\nsorban\n</channel>`
    const ex = scanChannelExchanges([
      tl({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(NOW - 399), content: tag }),
      tl({ type: 'attachment', timestamp: iso(NOW - 200), attachment: { type: 'queued_command', prompt: tag } }),
    ])
    expect(ex.inbound).toHaveLength(1)
    expect(ex.inbound[0].atMs).toBe((NOW - 400) * 1000)
    expect(unansweredInbound(ex, NOW * 1000, 120_000).map((i) => i.chatId)).toEqual(['Q'])
  })
})

describe('(B) wall and replies', () => {
  it('a pane banner walls; otherwise the shared plan at the threshold does', () => {
    expect(wallStateFor({ resetsAt: '7:20pm' }, snap(10, 10), 95)).toMatchObject({ walled: true, key: 'pane:7:20pm', resetsAtText: '7:20pm' })
    expect(wallStateFor(null, snap(96, 10), 95)).toMatchObject({ walled: true, key: `five_hour:${NOW + 3600}` })
    expect(wallStateFor(null, snap(94, 10), 95).walled).toBe(false)
  })
  it('the banner 12-hour time reads as 24-hour in Hungarian, other forms stay as printed', () => {
    expect(bannerTimeFor('9:20pm', 'hu')).toBe('21:20')
    expect(bannerTimeFor('2am', 'hu')).toBe('02:00')
    expect(bannerTimeFor('12:05am', 'hu')).toBe('00:05')
    expect(bannerTimeFor('Sep 28, 5pm (UTC)', 'hu')).toBe('Sep 28, 5pm (UTC)')
    expect(bannerTimeFor('9:20pm', 'en')).toBe('9:20pm')
    expect(formatAutoReply(wallStateFor({ resetsAt: '9:20pm' }, snap(0, 0), 95), 'hu')).toContain('21:20 körül')
  })
  it('one auto-reply per agent + chat + wall', () => {
    const wall = wallStateFor(null, snap(96, 10), 95)
    const pending = [{ chatId: 'B', messageId: '2', user: 'u', source: 's', atMs: 1, text: 't' }]
    expect(decideAutoReplies('alex', wall, pending, [])).toHaveLength(1)
    const rec = [{ agent: 'alex', chatId: 'B', messageId: '2', wallKey: wall.key, repliedAt: 1, source: 's', user: 'u', text: 't', atMs: 1 }]
    expect(decideAutoReplies('alex', wall, pending, rec)).toHaveLength(0)
    expect(decideAutoReplies('coco', wall, pending, rec)).toHaveLength(1)
  })
  it('hand-back only after the wall lifts, only while still unanswered', () => {
    const rec = [{ agent: 'alex', chatId: 'B', messageId: '2', wallKey: 'k', repliedAt: 1, source: 's', user: 'u', text: 't', atMs: 5 }]
    const open = [{ chatId: 'B', messageId: '2', user: 'u', source: 's', atMs: 5, text: 't' }]
    const walled = wallStateFor({ resetsAt: null }, snap(0, 0), 95)
    const free = wallStateFor(null, snap(10, 10), 95)
    expect(decideHandBacks('alex', walled, rec, open)).toHaveLength(0)
    expect(decideHandBacks('alex', free, rec, open)).toHaveLength(1)
    expect(decideHandBacks('alex', free, rec, [])).toHaveLength(0)
  })
})

describe('tick', () => {
  function deps(over: Partial<QuotaNoticeDeps> & { planList?: PlanQuota[]; state?: QuotaNoticeState; lines?: string[]; wall?: { resetsAt: string | null } | null; q?: QuotaSnapshot }) {
    let state: QuotaNoticeState = over.state ?? { notified: {}, autoReplies: [] }
    const d: QuotaNoticeDeps = {
      now: () => NOW * 1000,
      config: { noticeEnabled: true, noticePct: 90, autoReplyEnabled: true, autoReplyPct: 95, autoReplyGraceSec: 120, dryRun: false },
      lang: () => 'hu',
      plans: () => over.planList ?? [{ planId: DEFAULT_PLAN_ID, label: 'alap (flotta)', snap: over.q ?? snap(10, 10) }],
      planOf: () => DEFAULT_PLAN_ID,
      notifyOwner: vi.fn(async () => true),
      channelAgents: () => ['alex'],
      paneWall: async () => over.wall ?? null,
      transcriptLines: () => over.lines ?? [],
      sendChannel: vi.fn(async () => true),
      handBack: vi.fn(async () => true),
      loadState: () => JSON.parse(JSON.stringify(state)),
      saveState: (s) => { state = s },
      ...over,
    }
    return { d, getState: () => state }
  }

  it('notifies the owner once, and not again on the next tick', async () => {
    const { d, getState } = deps({ q: snap(92, 10) })
    await runQuotaNoticeTick(d)
    await runQuotaNoticeTick({ ...d, loadState: () => getState() })
    expect(d.notifyOwner).toHaveBeenCalledTimes(1)
  })

  it('a lost owner notice is retried', async () => {
    const { d } = deps({ q: snap(92, 10), notifyOwner: vi.fn(async () => false) })
    await runQuotaNoticeTick(d)
    await runQuotaNoticeTick(d)
    expect(d.notifyOwner).toHaveBeenCalledTimes(2)
  })

  it('auto-replies once at the wall, then hands back after it lifts', async () => {
    const lines = [inboundLine('B', '2', iso(NOW - 300), 'kérdés')]
    const walled = deps({ wall: { resetsAt: '7:20pm' }, lines })
    await runQuotaNoticeTick(walled.d)
    await runQuotaNoticeTick({ ...walled.d, loadState: () => walled.getState() })
    expect(walled.d.sendChannel).toHaveBeenCalledTimes(1)
    expect((walled.d.sendChannel as ReturnType<typeof vi.fn>).mock.calls[0][2]).toContain('19:20')

    const lifted = deps({ wall: null, lines, state: walled.getState() })
    await runQuotaNoticeTick(lifted.d)
    expect(lifted.d.handBack).toHaveBeenCalledTimes(1)
    expect((lifted.d.handBack as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain('chat_id=B')
    await runQuotaNoticeTick({ ...lifted.d, loadState: () => lifted.getState() })
    expect(lifted.d.handBack).toHaveBeenCalledTimes(1)
  })

  it('no hand-back when the agent already answered', async () => {
    const lines = [inboundLine('B', '2', iso(NOW - 300)), replyLine('B', iso(NOW - 10))]
    const rec = [{ agent: 'alex', chatId: 'B', messageId: '2', wallKey: 'k', repliedAt: 1, source: 's', user: 'u', text: 't', atMs: (NOW - 300) * 1000 }]
    const { d, getState } = deps({ wall: null, lines, state: { notified: {}, autoReplies: rec } })
    await runQuotaNoticeTick(d)
    expect(d.handBack).not.toHaveBeenCalled()
    expect(getState().autoReplies[0].handedBack).toBe(true)
  })

  it('dry-run sends nothing', async () => {
    const { d } = deps({ q: snap(99, 10), wall: { resetsAt: null }, lines: [inboundLine('B', '2', iso(NOW - 300))] })
    await runQuotaNoticeTick({ ...d, config: { ...d.config, dryRun: true } })
    expect(d.notifyOwner).not.toHaveBeenCalled()
    expect(d.sendChannel).not.toHaveBeenCalled()
  })

  it('auto-reply off: no channel send even at the wall', async () => {
    const { d } = deps({ wall: { resetsAt: null }, lines: [inboundLine('B', '2', iso(NOW - 300))] })
    await runQuotaNoticeTick({ ...d, config: { ...d.config, autoReplyEnabled: false } })
    expect(d.sendChannel).not.toHaveBeenCalled()
  })
})

describe('multi-plan', () => {
  const two = (a: QuotaSnapshot, b: QuotaSnapshot): PlanQuota[] => [
    { planId: DEFAULT_PLAN_ID, label: 'alap (flotta)', snap: a },
    { planId: 'ceges', label: 'Céges', snap: b },
  ]
  function harness(plans: PlanQuota[], planOf: (a: string) => string, wall: { resetsAt: string | null } | null = null, lines: string[] = []) {
    let state: QuotaNoticeState = { notified: {}, autoReplies: [] }
    const sent: string[] = []
    const replies: string[] = []
    const d: QuotaNoticeDeps = {
      now: () => NOW * 1000,
      config: { noticeEnabled: true, noticePct: 90, autoReplyEnabled: true, autoReplyPct: 95, autoReplyGraceSec: 120, dryRun: false },
      lang: () => 'hu', plans: () => plans, planOf,
      notifyOwner: async (t) => { sent.push(t); return true },
      channelAgents: () => ['alex', 'coco'],
      paneWall: async () => wall,
      transcriptLines: () => lines,
      sendChannel: async (agent, chat, t) => { replies.push(`${agent}:${chat}:${t}`); return true },
      handBack: async () => true,
      loadState: () => JSON.parse(JSON.stringify(state)), saveState: (s) => { state = s },
    }
    return { d, sent, replies, state: () => state }
  }

  it('one notice per plan per window, each naming its plan', async () => {
    const h = harness(two(snap(92, 10), snap(91, 10, NOW + 7000)), () => DEFAULT_PLAN_ID)
    await runQuotaNoticeTick(h.d)
    await runQuotaNoticeTick(h.d)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]).toContain('„alap (flotta)” előfizetés')
    expect(h.sent[1]).toContain('„Céges” előfizetés')
    expect(Object.keys(h.state().notified).sort()).toEqual(['ceges', DEFAULT_PLAN_ID])
  })

  it('the auto-reply uses the numbers of the plan THAT agent runs on', async () => {
    const lines = [inboundLine('B', '2', iso(NOW - 300))]
    // default plan at 97 %, "ceges" at 20 %: alex is on default (walled), coco on ceges (free)
    const h = harness(two(snap(97, 10), snap(20, 10)), (a) => (a === 'coco' ? 'ceges' : DEFAULT_PLAN_ID), null, lines)
    await runQuotaNoticeTick(h.d)
    expect(h.replies.map((r) => r.split(':')[0])).toEqual(['alex'])
  })

  it('a plan with no numbers: only the pane banner can wall the agent', async () => {
    const lines = [inboundLine('B', '2', iso(NOW - 300))]
    const missing: QuotaSnapshot = { status: 'missing', reason: 'no-file', ageSec: null, maxAgeSec: 0, fiveHour: null, sevenDay: null }
    const noBanner = harness(two(snap(10, 10), missing), () => 'ceges', null, lines)
    await runQuotaNoticeTick(noBanner.d)
    expect(noBanner.replies).toEqual([])
    expect(noBanner.sent).toEqual([])
    const banner = harness(two(snap(10, 10), missing), () => 'ceges', { resetsAt: '9pm' }, lines)
    await runQuotaNoticeTick(banner.d)
    expect(banner.replies).toHaveLength(2)
    expect(banner.replies[0]).toContain('21:00 körül')
  })

  it('an unknown plan id reads as no numbers', () => {
    expect(snapshotOfPlan(two(snap(99, 99), snap(99, 99)), 'gone').status).toBe('missing')
  })

  it('reads a claude-plans-state observation (ms observedAt, usedPercent/resetsAt) with freshness', () => {
    const obs = { observedAt: (NOW - 60) * 1000, windows: { five_hour: { usedPercent: 93, resetsAt: NOW + 100 }, seven_day: { usedPercent: 50, resetsAt: NOW + 9999 } } }
    expect(planStateSnapshot(obs, NOW)).toMatchObject({ status: 'ok', fiveHour: { usedPercentage: 93 } })
    expect(planStateSnapshot(obs, NOW + 5000).status).toBe('stale')
    expect(planStateSnapshot(undefined, NOW).status).toBe('missing')
  })

  it('a state file from the single-plan shape is read as the default plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qn-state-'))
    const f = join(dir, 's.json')
    writeFileSync(f, JSON.stringify({ notified: { five_hour: 123, ceges: { seven_day: 5 } }, autoReplies: [] }))
    expect(loadQuotaNoticeState(f).notified).toEqual({ [DEFAULT_PLAN_ID]: { five_hour: 123 }, ceges: { seven_day: 5 } })
  })
})
