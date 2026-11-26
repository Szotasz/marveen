import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readQuotaNoticeConfig, readUsageCollectSnapshot, fresherSnapshot, decideThresholdNotices, formatThresholdNotice,
  scanChannelExchanges, unansweredInbound, wallStateFor, decideAutoReplies, decideHandBacks, runQuotaNoticeTick,
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
  it('defaults: notice on at 90, auto-reply off at 95, grace 120', () => {
    expect(readQuotaNoticeConfig({})).toEqual({ noticeEnabled: true, noticePct: 90, autoReplyEnabled: false, autoReplyPct: 95, autoReplyGraceSec: 120, dryRun: false })
  })
  it('reads overrides and rejects nonsense percentages', () => {
    const c = readQuotaNoticeConfig({ QUOTA_NOTICE: '0', QUOTA_NOTICE_PCT: '80', QUOTA_AUTOREPLY: '1', QUOTA_AUTOREPLY_PCT: '150', QUOTA_NOTICE_DRY_RUN: '1' })
    expect(c).toMatchObject({ noticeEnabled: false, noticePct: 80, autoReplyEnabled: true, autoReplyPct: 95, dryRun: true })
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
  it('Hungarian text: accents, percentage, no em dash', () => {
    const t = formatThresholdNotice({ kind: 'five_hour', pct: 90.4, resetsAt: NOW + 3600 }, 'hu', NOW)
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

describe('(B) wall and replies', () => {
  it('a pane banner walls; otherwise the shared plan at the threshold does', () => {
    expect(wallStateFor({ resetsAt: '7:20pm' }, snap(10, 10), 95)).toMatchObject({ walled: true, key: 'pane:7:20pm', resetsAtText: '7:20pm' })
    expect(wallStateFor(null, snap(96, 10), 95)).toMatchObject({ walled: true, key: `five_hour:${NOW + 3600}` })
    expect(wallStateFor(null, snap(94, 10), 95).walled).toBe(false)
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
  function deps(over: Partial<QuotaNoticeDeps> & { state?: QuotaNoticeState; lines?: string[]; wall?: { resetsAt: string | null } | null; q?: QuotaSnapshot }) {
    let state: QuotaNoticeState = over.state ?? { notified: {}, autoReplies: [] }
    const d: QuotaNoticeDeps = {
      now: () => NOW * 1000,
      config: { noticeEnabled: true, noticePct: 90, autoReplyEnabled: true, autoReplyPct: 95, autoReplyGraceSec: 120, dryRun: false },
      lang: () => 'hu',
      snapshot: () => over.q ?? snap(10, 10),
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
    expect((walled.d.sendChannel as ReturnType<typeof vi.fn>).mock.calls[0][2]).toContain('7:20pm')

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
