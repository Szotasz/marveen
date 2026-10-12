import { describe, it, expect } from 'vitest'
import { buildRecoveryBrief, parseGitStatusShort, RECOVERY_BRIEF_MAX_CHARS, type RecoveryFacts } from '../web/restart-recovery-brief.js'

const facts = (over: Partial<RecoveryFacts> = {}): RecoveryFacts => ({
  agent: 'devy',
  branch: 'devy/some-task',
  dirty: [],
  dirtyTruncated: false,
  inProgress: [],
  ...over,
})

describe('an idle agent is never interrupted', () => {
  it('says nothing when there is no work in flight', () => {
    // The guard that makes auto-injection safe at all. A restart of a genuinely
    // idle agent must not put "you were doing nothing" into its fresh prompt --
    // that is noise the agent then has to spend a turn answering.
    expect(buildRecoveryBrief(facts())).toBeNull()
  })

  it('says nothing even when a branch is known but nothing is dirty', () => {
    expect(buildRecoveryBrief(facts({ branch: 'develop' }))).toBeNull()
  })
})

describe('a brief is sent when there is something concrete to resume', () => {
  it('names the in_progress cards', () => {
    const b = buildRecoveryBrief(facts({ inProgress: [{ id: 'abc12345', title: 'Fix the thing' }] }))!
    expect(b).toContain('abc12345: Fix the thing')
    expect(b).toContain('FRISS session')
  })

  it('names the branch and the uncommitted files', () => {
    const b = buildRecoveryBrief(facts({
      branch: 'devy/work',
      dirty: [{ code: ' M', path: 'src/a.ts' }, { code: '??', path: 'src/b.ts' }],
    }))!
    expect(b).toContain('devy/work')
    expect(b).toContain(' M src/a.ts')
    expect(b).toContain('?? src/b.ts')
  })

  it('still works when the branch is unknown', () => {
    const b = buildRecoveryBrief(facts({ branch: null, dirty: [{ code: ' M', path: 'x.ts' }] }))!
    expect(b).toContain('munkakonyvtaradban')
    expect(b).not.toContain('null')
  })

  it('says so when the file list was cut', () => {
    const b = buildRecoveryBrief(facts({ dirty: [{ code: ' M', path: 'a' }], dirtyTruncated: true }))!
    expect(b).toContain('levagva')
  })
})

describe('the brief states facts, it does not order a resume', () => {
  it('tells the agent to verify before continuing', () => {
    // Facts collected around a restart can be stale by the time they are read,
    // and the fleet has been burned by confident stale numbers before. The
    // brief must send the agent to check, not to act.
    const b = buildRecoveryBrief(facts({ inProgress: [{ id: 'c1', title: 'T' }] }))!
    expect(b).toMatch(/ellenorizd/i)
    expect(b).toMatch(/ne kezdd ujra/i)
  })

  it('stays within the injection cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ code: ' M', path: `src/very/long/path/number/${i}/file.ts` }))
    const b = buildRecoveryBrief(facts({ dirty: many }))!
    expect(b.length).toBeLessThanOrEqual(RECOVERY_BRIEF_MAX_CHARS)
    expect(b.endsWith('…')).toBe(true)
  })
})

describe('parseGitStatusShort', () => {
  it('keeps the two-column code verbatim, because " M" and "M " differ', () => {
    const { dirty } = parseGitStatusShort(' M src/a.ts\nM  src/b.ts\n?? src/c.ts\n', 10)
    expect(dirty).toEqual([
      { code: ' M', path: 'src/a.ts' },
      { code: 'M ', path: 'src/b.ts' },
      { code: '??', path: 'src/c.ts' },
    ])
  })

  it('reports truncation instead of silently dropping files', () => {
    const out = Array.from({ length: 5 }, (_, i) => ` M f${i}.ts`).join('\n')
    const { dirty, truncated } = parseGitStatusShort(out, 3)
    expect(dirty).toHaveLength(3)
    expect(truncated).toBe(true)
  })

  it('treats empty git output as a clean tree', () => {
    expect(parseGitStatusShort('', 10)).toEqual({ dirty: [], truncated: false })
    expect(parseGitStatusShort('\n\n', 10)).toEqual({ dirty: [], truncated: false })
  })
})
