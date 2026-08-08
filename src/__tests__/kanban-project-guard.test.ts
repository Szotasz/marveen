import { describe, it, expect } from 'vitest'
import { resolveCardProject } from '../web/kanban-project-guard.js'

// The house rule, moved from a prompt into the endpoint.
//
// Every card carries a project because the cost report attributes spend by
// project; a card without one is work whose cost cannot be traced. The reason
// it moved is the same one the morning-briefing guard moved for: a rule
// written into a prompt only binds the sessions that read it.

describe('a card that names its project', () => {
  it('is accepted', () => {
    expect(resolveCardProject({ project: 'marveen' })).toMatchObject({ ok: true, project: 'marveen' })
  })

  it('is trimmed, so " marveen" and "marveen" do not become two projects in the report', () => {
    expect(resolveCardProject({ project: '  marveen  ' }).project).toBe('marveen')
  })

  it('may name a project nobody has used yet', () => {
    // The guard must not forbid a new project: that would send people back to
    // creating cards by hand, which is what this is replacing.
    expect(resolveCardProject({ project: 'brand-new' }, { knownProjects: ['marveen'] })).toMatchObject({
      ok: true,
      project: 'brand-new',
    })
  })
})

describe('a card with no project', () => {
  it('is refused', () => {
    expect(resolveCardProject({}).ok).toBe(false)
  })

  it('is refused for a blank one too, not just a missing one', () => {
    expect(resolveCardProject({ project: '   ' }).ok).toBe(false)
    expect(resolveCardProject({ project: 42 }).ok).toBe(false)
  })

  it('says WHY, in the words of the rule rather than as a schema error', () => {
    const { error } = resolveCardProject({})
    expect(error).toMatch(/kötelező a project/i)
    expect(error).toMatch(/nem attribuálható/i)
  })

  it('lists the projects already in use, so the caller picks instead of inventing', () => {
    // "revenue radar" next to "revenue-radar" is two projects in the report and
    // one in everybody's head.
    const { error } = resolveCardProject({}, { knownProjects: ['marveen', 'revenue-radar'] })
    expect(error).toContain('marveen, revenue-radar')
  })

  it('does not pretend to know names it was not given', () => {
    expect(resolveCardProject({}).error).not.toMatch(/Használatban/)
  })
})

describe('a subtask', () => {
  it('inherits the parent project without repeating it', () => {
    // The breakdown flow creates children without restating the field, and a
    // restated field is one that will eventually disagree with the parent.
    expect(resolveCardProject({ parent_id: 'abc123' }, { parentProject: 'revenue-radar' })).toMatchObject({
      ok: true,
      project: 'revenue-radar',
    })
  })

  it('still prefers an explicit project when the caller gives one', () => {
    expect(
      resolveCardProject({ parent_id: 'abc123', project: 'peci01-infra' }, { parentProject: 'marveen' }).project,
    ).toBe('peci01-infra')
  })

  it('is refused when the parent has no project either', () => {
    // Creating it would spread the untraceable card instead of stopping at one.
    const result = resolveCardProject({ parent_id: 'abc123' }, { parentProject: null })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/szülő/i)
  })
})
