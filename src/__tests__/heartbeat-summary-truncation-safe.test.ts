import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildHeartbeatSummaryResponse,
  HEARTBEAT_SUMMARY_TITLE_MAX,
  HEARTBEAT_SUMMARY_WAITING_CAP,
} from '../web/routes/kanban.js'

// HBKANBANDRIFT819: the 16:42 heartbeat reported waiting:12 against a real
// 280. The endpoint's counts were CORRECT -- but the payload was ~31KB (board
// titles here run to 15KB each) and `counts` serialized LAST, so a reader
// that lost the tail lost exactly the numbers and counted the visible list
// instead. Same family as HBMEMBLIND807/819: the number's production must not
// depend on the measured party's reading stamina. Three properties pinned:
// counts-first ordering, server-side truncation, capped list with FULL totals.

function card(id: string, title: string, status: string, updated_at: number) {
  return { id, title, status, priority: 'normal', assignee: null, updated_at }
}

function bigSummary() {
  const waiting = Array.from({ length: 280 }, (_, i) =>
    card(`W${i}`, 'x'.repeat(15_000), 'waiting', 1000 + i))
  const urgent = Array.from({ length: 4 }, (_, i) =>
    card(`U${i}`, 'sürgős '.repeat(400), 'planned', 2000 + i))
  return { urgent, in_progress: [], waiting }
}

describe('buildHeartbeatSummaryResponse (pure)', () => {
  it('counts is the FIRST serialized key, so truncated reads lose lists, never numbers', () => {
    const json = JSON.stringify(buildHeartbeatSummaryResponse(bigSummary(), 2, 305, 159.7))
    expect(json.startsWith('{"counts":')).toBe(true)
    // The whole counts object must fit well inside any sane read window: the
    // first 200 bytes carry every number even if 99% of the payload is lost.
    const head = json.slice(0, 200)
    expect(head).toContain('"waiting":280')
    // planned has no list at all, so its ONLY existence is this number --
    // measured 2026-08-19 17:00: planned: 0 reported against a real 305.
    expect(head).toContain('"planned":305')
    expect(head).toContain('"new_hot_memories_1h":2')
  })

  it('counts.waiting is the FULL total, never the capped list length (the 2026-08-04 lesson in endpoint form)', () => {
    const r = buildHeartbeatSummaryResponse(bigSummary(), 0, 305, 159.7)
    expect(r.counts.waiting).toBe(280)
    expect(r.waiting.length).toBe(HEARTBEAT_SUMMARY_WAITING_CAP)
    expect(r.waiting_shown).toBe(HEARTBEAT_SUMMARY_WAITING_CAP)
  })

  it('the waiting list carries the most recently UPDATED cards', () => {
    const r = buildHeartbeatSummaryResponse(bigSummary(), 0, 305, 159.7)
    // Fixture updated_at grows with the index, so the newest ids are the highest.
    expect(r.waiting[0].id).toBe('W279')
    expect(r.waiting[HEARTBEAT_SUMMARY_WAITING_CAP - 1].id).toBe(`W${280 - HEARTBEAT_SUMMARY_WAITING_CAP}`)
  })

  it('every title is truncated server-side; short titles pass through untouched', () => {
    const r = buildHeartbeatSummaryResponse(bigSummary(), 0, 305, 159.7)
    for (const c of [...r.urgent, ...r.waiting]) {
      expect(c.title.length).toBeLessThanOrEqual(HEARTBEAT_SUMMARY_TITLE_MAX + 1) // +1 for the ellipsis
    }
    const small = buildHeartbeatSummaryResponse(
      { urgent: [card('A', 'rövid cím', 'waiting', 1)], in_progress: [], waiting: [] }, 0, 0, null)
    expect(small.urgent[0].title).toBe('rövid cím')
  })

  it('the payload with 280 huge-titled cards stays small enough to never truncate in practice', () => {
    const json = JSON.stringify(buildHeartbeatSummaryResponse(bigSummary(), 0, 305, 159.7))
    // Pre-fix this was ~4.2MB with these fixtures (280 x 15KB); the cap+trunc
    // must keep it in the low KB range.
    expect(json.length).toBeLessThan(10_000)
  })
})

// --- wiring contract (structurally anchored windows) ---

const ROOT = join(__dirname, '..', '..')
const KANBAN = readFileSync(join(ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')
const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')

describe('wiring: the endpoint serves the pure builder, the scaffold forbids counting lists', () => {
  it('the heartbeat-summary handler goes through buildHeartbeatSummaryResponse', () => {
    const start = KANBAN.indexOf("'/api/kanban/heartbeat-summary'")
    expect(start).toBeGreaterThanOrEqual(0)
    const handler = KANBAN.slice(start, KANBAN.indexOf('return true', start))
    expect(handler).toMatch(/buildHeartbeatSummaryResponse\(/)
    // planned must come from its sanctioned server-side counter, or the agent
    // manufactures it again (planned: 0 vs real 305, 2026-08-19 17:00).
    expect(handler).toMatch(/countPlannedKanbanCards\(\)/)
  })

  it('the scaffold says numbers come from the COUNTS line only and names the drift incident', () => {
    // Wording moved with the HBMEMBLIND819 third contract: the copy-surface
    // is now the instrument's COUNTS line (fed by counts.*), and the ban on
    // counting the capped lists is stated next to it.
    expect(SCAFFOLD).toMatch(/EVERY number comes from this line and nowhere else/)
    expect(SCAFFOLD).toMatch(/HBKANBANDRIFT819/)
    expect(SCAFFOLD).toMatch(/counting list items once\s+reported waiting: 12 against a real 280/)
  })
})
