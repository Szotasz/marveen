import { describe, it, expect } from 'vitest'
import { groupByRelease, type UpdateCommit } from '../web/update-checker.js'

// Unit tests for the release-grouping that turns the flat newest-first commit
// list into version buckets (card cbe2a240, PR-A). A `chore(release): vX`
// commit starts a version group; the non-release commits older than it (down to
// the next release marker) are what shipped in vX; commits newer than the newest
// release marker form the leading "upcoming" group.

function c(short: string, message: string): UpdateCommit {
  return { sha: short.padEnd(40, '0'), short, message, author: 'Dev', date: '2026-07-09T00:00:00Z' }
}

describe('groupByRelease', () => {
  it('groups commits under their enclosing release, newest-first', () => {
    const commits = [
      c('aaa', 'feat: upcoming thing'),
      c('bbb', 'chore(release): v1.20.0 -- memory isolation + worker robustness'),
      c('ccc', 'fix(voice): self-heal'),
      c('ddd', 'feat(memory): isolation'),
      c('eee', 'chore(release): v1.19.0 -- SSH Vault'),
      c('fff', 'feat(vault): SSH Vault'),
    ]
    const msgs = commits.map(x => x.message)
    const groups = groupByRelease(commits, msgs)

    expect(groups.map(g => g.version)).toEqual(['', 'v1.20.0', 'v1.19.0'])
    // upcoming = commits above the newest release marker
    expect(groups[0].commits.map(x => x.short)).toEqual(['aaa'])
    // v1.20.0 = the commits older than its marker, down to the next marker
    expect(groups[1].commits.map(x => x.short)).toEqual(['ccc', 'ddd'])
    expect(groups[1].summary).toBe('memory isolation + worker robustness')
    // v1.19.0 = the remaining older commits
    expect(groups[2].commits.map(x => x.short)).toEqual(['fff'])
    expect(groups[2].summary).toBe('SSH Vault')
  })

  it('prefers the release-commit body over the subject summary, stripping trailers', () => {
    const relMsg = [
      'chore(release): v1.21.0 -- short subject',
      '',
      '- feature one',
      '- feature two',
      '',
      'Co-Authored-By: Claude <noreply@anthropic.com>',
    ].join('\n')
    const commits = [c('rel', 'chore(release): v1.21.0 -- short subject'), c('x1', 'feat: thing')]
    const groups = groupByRelease(commits, [relMsg, 'feat: thing'])
    expect(groups[0].version).toBe('v1.21.0')
    expect(groups[0].summary).toBe('- feature one\n- feature two')
    expect(groups[0].summary).not.toContain('Co-Authored-By')
  })

  it('falls back to the subject summary when the body is empty (historical inconsistency)', () => {
    const commits = [c('rel', 'chore(release): v1.19.0 -- SSH Vault, owner-gated toggle')]
    const groups = groupByRelease(commits, ['chore(release): v1.19.0 -- SSH Vault, owner-gated toggle\n\nCo-Authored-By: x <y@z>'])
    expect(groups[0].summary).toBe('SSH Vault, owner-gated toggle')
  })

  it('matches an em-dash separator in a release subject', () => {
    const commits = [c('rel', 'chore(release): v1.18.0 — em dash release')]
    const groups = groupByRelease(commits, ['chore(release): v1.18.0 — em dash release'])
    expect(groups[0].version).toBe('v1.18.0')
    expect(groups[0].summary).toBe('em dash release')
  })

  it('puts everything in upcoming when there is no release marker', () => {
    const commits = [c('a', 'feat: a'), c('b', 'fix: b')]
    const groups = groupByRelease(commits, ['feat: a', 'fix: b'])
    expect(groups).toHaveLength(1)
    expect(groups[0].version).toBe('')
    expect(groups[0].commits.map(x => x.short)).toEqual(['a', 'b'])
  })

  it('omits the empty upcoming group when the newest commit is a release', () => {
    const commits = [c('rel', 'chore(release): v1.20.0 -- x'), c('a', 'feat: a')]
    const groups = groupByRelease(commits, ['chore(release): v1.20.0 -- x', 'feat: a'])
    expect(groups.map(g => g.version)).toEqual(['v1.20.0'])
  })
})
