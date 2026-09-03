// Contract tests for the project-overview summary (WORKERBOOT1-style: calls the
// real production entry points against an in-memory database seeded with the
// production schema, mirroring kanban-labels.test.ts). Everything except the
// human-written description is computed live from kanban_cards, so most of
// this suite is about the AGGREGATION rules (which cards count, how the
// completion ratio and "who's on it" fallback behave), not storage plumbing.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initDatabase, createKanbanCard, updateKanbanCard, getKanbanCard,
  listKanbanProjectSummaries, upsertKanbanProjectDescription,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('listKanbanProjectSummaries', () => {
  it('is empty when no card has a project', () => {
    createKanbanCard({ id: 'a', title: 'A' })
    expect(listKanbanProjectSummaries()).toEqual([])
  })

  it('groups cards by project and counts total/done', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', status: 'done' })
    createKanbanCard({ id: 'b', title: 'B', project: 'demo', status: 'in_progress' })
    createKanbanCard({ id: 'c', title: 'C', project: 'demo', status: 'planned' })
    const [summary] = listKanbanProjectSummaries()
    expect(summary.project).toBe('demo')
    expect(summary.cardTotal).toBe(3)
    expect(summary.cardDone).toBe(1)
  })

  it('lists multiple projects, alphabetically ordered', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'zebra' })
    createKanbanCard({ id: 'b', title: 'B', project: 'apple' })
    const projects = listKanbanProjectSummaries().map((s) => s.project)
    expect(projects).toEqual(['apple', 'zebra'])
  })

  it('excludes archived cards from the counts (matches listKanbanProjects\' own filter)', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', status: 'done' })
    createKanbanCard({ id: 'b', title: 'B', project: 'demo' })
    updateKanbanCard('a', { archived_at: Math.floor(Date.now() / 1000) })
    const [summary] = listKanbanProjectSummaries()
    expect(summary.cardTotal).toBe(1)
    expect(summary.cardDone).toBe(0)
  })

  it('a project whose every card is archived does not appear at all', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'wrapped-up', status: 'done' })
    updateKanbanCard('a', { archived_at: Math.floor(Date.now() / 1000) })
    expect(listKanbanProjectSummaries()).toEqual([])
  })

  it('reports MAX(updated_at) across the project\'s cards as lastActivityAt', () => {
    // updateKanbanCard always stamps updated_at = Math.floor(Date.now()/1000)
    // itself (an explicit updated_at in the fields is not honoured), so the
    // only reliable way to put a's and b's rows in a known order is to
    // control the clock -- a real-time delay could land both in the same
    // second and let the test pass even if the aggregate picked the wrong row.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
      createKanbanCard({ id: 'b', title: 'B', project: 'demo' })
      vi.setSystemTime(2_000_000) // strictly later -- touch only 'a'
      updateKanbanCard('a', { title: 'A revised' })
      const a = getKanbanCard('a')!
      const b = getKanbanCard('b')!
      expect(a.updated_at).toBeGreaterThan(b.updated_at)
      const [summary] = listKanbanProjectSummaries()
      expect(summary.lastActivityAt).toBe(a.updated_at)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers assignees on in_progress/testing cards over the full history', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'agent-a', status: 'done' })
    createKanbanCard({ id: 'b', title: 'B', project: 'demo', assignee: 'agent-b', status: 'in_progress' })
    const [summary] = listKanbanProjectSummaries()
    expect(summary.activeAssignees).toEqual(['agent-b'])
  })

  it('falls back to every assignee ever seen when nothing is currently in flight', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'agent-a', status: 'done' })
    createKanbanCard({ id: 'b', title: 'B', project: 'demo', assignee: 'agent-c', status: 'waiting' })
    const [summary] = listKanbanProjectSummaries()
    expect(summary.activeAssignees.sort()).toEqual(['agent-a', 'agent-c'])
  })

  it('description is null when no one has ever set one', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
    const [summary] = listKanbanProjectSummaries()
    expect(summary.description).toBeNull()
    expect(summary.descriptionUpdatedAt).toBeNull()
  })

  it('joins in the stored description once one has been set', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
    upsertKanbanProjectDescription('demo', 'A short human summary.')
    const [summary] = listKanbanProjectSummaries()
    expect(summary.description).toBe('A short human summary.')
    expect(summary.descriptionUpdatedAt).toEqual(expect.any(Number))
  })
})

describe('upsertKanbanProjectDescription', () => {
  it('creates a description on first write and reports changed:true', () => {
    const r = upsertKanbanProjectDescription('demo', 'First description.')
    expect(r.changed).toBe(true)
  })

  it('trims surrounding whitespace before storing', () => {
    upsertKanbanProjectDescription('demo', '  padded text  ')
    createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
    const [summary] = listKanbanProjectSummaries()
    expect(summary.description).toBe('padded text')
  })

  it('a resubmit of the IDENTICAL text is a no-op (changed:false)', () => {
    upsertKanbanProjectDescription('demo', 'Same text.')
    const r = upsertKanbanProjectDescription('demo', 'Same text.')
    expect(r.changed).toBe(false)
  })

  it('a resubmit that only differs by surrounding whitespace is still a no-op', () => {
    upsertKanbanProjectDescription('demo', 'Same text.')
    const r = upsertKanbanProjectDescription('demo', '  Same text.  ')
    expect(r.changed).toBe(false)
  })

  it('does not bump description_updated_at on a no-op resubmit', () => {
    upsertKanbanProjectDescription('demo', 'Same text.')
    createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
    const before = listKanbanProjectSummaries()[0].descriptionUpdatedAt
    upsertKanbanProjectDescription('demo', 'Same text.')
    const after = listKanbanProjectSummaries()[0].descriptionUpdatedAt
    expect(after).toBe(before)
  })

  it('a genuinely different text changes:true and updates the stored value', () => {
    upsertKanbanProjectDescription('demo', 'Old text.')
    const r = upsertKanbanProjectDescription('demo', 'New text.')
    expect(r.changed).toBe(true)
    createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
    expect(listKanbanProjectSummaries()[0].description).toBe('New text.')
  })

  it('writing an empty string to a project with no prior row is a no-op (no blank row created)', () => {
    const r = upsertKanbanProjectDescription('never-described', '')
    expect(r.changed).toBe(false)
  })

  it('can set a description for a project BEFORE any card is tagged with it', () => {
    upsertKanbanProjectDescription('future-project', 'Set up ahead of time.')
    createKanbanCard({ id: 'a', title: 'A', project: 'future-project' })
    expect(listKanbanProjectSummaries()[0].description).toBe('Set up ahead of time.')
  })

  it('clearing an existing description (empty string) is accepted and stored', () => {
    upsertKanbanProjectDescription('demo', 'Will be cleared.')
    const r = upsertKanbanProjectDescription('demo', '')
    expect(r.changed).toBe(true)
    createKanbanCard({ id: 'a', title: 'A', project: 'demo' })
    expect(listKanbanProjectSummaries()[0].description).toBe('')
  })
})
