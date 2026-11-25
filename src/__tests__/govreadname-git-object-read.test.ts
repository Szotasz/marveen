// GOVREADNAME1125 (Samu's #3148 review, Marveen 85558): the governance gate's protected-store rule catches a protected
// file's NAME anywhere in a segment, and a segment that names it may only be a plain read. `git show <rev>:<path>` was
// no read, so `git show origin/develop:templates/egress-vendor-hosts.json | jq ...` (a template of the same name) was
// denied. Now a git object read is one, in the narrow form gitObjectReadOnly accepts; every write stays denied.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, gitObjectReadOnly } from '../../scripts/self-pace-gate.mjs'

const N = 'egress-vendor-hosts.json'
const bash = (command: string) => gateDecision('Bash', { command }, { cwd: '/tmp' })
const PROT = { deny: true, reason: 'protected-store-file' }

describe('GOVREADNAME1125: a read of a protected name from a git object', () => {
  it.each([
    `git show origin/develop:templates/${N} | jq -c '{hosts, len:(._comment|length)}'`,
    `git show pr3148:templates/${N}`,
    `git -C /r/wt --no-pager show HEAD:templates/${N}`,
    `git cat-file -p HEAD:templates/${N}`,
    `git cat-file -s origin/main:store/${N}`,
    `jq -c .hosts /r/wt/templates/${N}`,
    `cat /r/store/${N}`,
  ])('free: %s', (c) => {
    expect(bash(c)).toEqual({ deny: false })
  })
  it.each([
    `echo '{"hosts":["x"]}' > /r/store/${N}`,
    `cp /tmp/x /r/store/${N}`,
    `git show HEAD:templates/${N} > /r/store/${N}`,
    `git show HEAD:templates/${N} --output=/r/store/${N}`,
    `git show --textconv HEAD:templates/${N}`,
    `git show --ext-diff HEAD -- templates/${N}`,
    `git show HEAD -- templates/${N}`,
    `git -c core.pager=sh show HEAD:templates/${N}`,
    `GIT_PAGER=sh git show HEAD:templates/${N}`,
    `git cat-file --textconv HEAD:templates/${N}`,
    `git cat-file --filters HEAD:templates/${N}`,
    `git checkout HEAD -- store/${N}`,
  ])('denied: %s', (c) => {
    expect(bash(c)).toEqual(PROT)
  })
  it('the Write and Edit tools on the store file stay denied', () => {
    expect(gateDecision('Write', { file_path: `/r/store/${N}`, content: '{}' }, { cwd: '/tmp' })).toEqual(PROT)
    expect(gateDecision('Edit', { file_path: `/r/store/${N}`, old_string: 'a', new_string: 'b' }, { cwd: '/tmp' })).toEqual(PROT)
  })
  it('gitObjectReadOnly: the accepted and refused shapes', () => {
    expect(gitObjectReadOnly(['show', 'HEAD:a/b.json'])).toBe(true)
    expect(gitObjectReadOnly(['-C', '/r', '--no-pager', 'show', 'x:y', 'z:w'])).toBe(true)
    expect(gitObjectReadOnly(['cat-file', 'blob', 'HEAD:a'])).toBe(true)
    for (const w of [['show'], ['show', 'HEAD'], ['show', '--', 'a'], ['show', '-p', 'HEAD:a'], ['show', '--textconv', 'HEAD:a'],
      ['show', '--output=/x', 'HEAD:a'], ['cat-file', '--textconv', 'HEAD:a'], ['cat-file', '-p'], ['cat-file', '-p', 'HEAD:a', 'x:y'],
      ['-c', 'a=b', 'show', 'HEAD:a'], ['log', 'HEAD:a'], []]) expect(gitObjectReadOnly(w), JSON.stringify(w)).toBe(false)
  })
})
