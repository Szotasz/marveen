// SUITETMPPIROS912: the suite gate and the hook-path guard must refuse the SAME
// transient roots, from ONE list. Two copies drifted apart is exactly how the
// 2026-09-12 false red happened: the rule was written down (SUITERED807 put it in
// the live-install message) but nothing measured the running root against it.
import { describe, it, expect } from 'vitest'
import { isTmpRootedPath, TMP_ROOT_PREFIXES } from '../web/tmp-root-prefixes.js'
import { isUnsafeHookCommand } from '../web/agent-scaffold.js'

// A LIST-DRIVEN LOOP CANNOT CATCH A SHRINKING LIST: if someone deletes a prefix,
// every `for (const p of TMP_ROOT_PREFIXES)` assertion below simply runs one round
// less and stays green. So the list is ALSO pinned literally. Adding a prefix is a
// deliberate act and updates this line; losing one goes red.
const EXPECTED = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']

describe('the shared list itself', () => {
  it('contains exactly the four transient roots, unchanged', () => {
    expect([...TMP_ROOT_PREFIXES].sort()).toEqual([...EXPECTED].sort())
  })
})

describe('isTmpRootedPath', () => {
  it('refuses every prefix in the shared list, as a ROOT', () => {
    for (const p of TMP_ROOT_PREFIXES) {
      expect(isTmpRootedPath(`${p}some/checkout`), p).toBe(true)
    }
  })

  it('refuses the exact scratchpad shape a fleet agent measures from', () => {
    // The real path from the 2026-09-12 measurement, macOS-resolved.
    expect(isTmpRootedPath('/private/tmp/claude-501/-Users-marvin-ClaudeClaw-agents-geri/x/scratchpad/mv')).toBe(true)
  })

  it('allows a home-rooted worktree', () => {
    expect(isTmpRootedPath('/Users/marvin/claw-test')).toBe(false)
    expect(isTmpRootedPath('/home/runner/work/marveen/marveen')).toBe(false)
  })

  it('does NOT refuse a home path that merely CONTAINS a tmp segment', () => {
    // The guard asks whether the ROOT is transient, not whether the string
    // mentions tmp anywhere -- otherwise a legitimate ~/tmp-notes/ checkout dies.
    expect(isTmpRootedPath('/Users/marvin/tmp/claw-test')).toBe(false)
    expect(isTmpRootedPath('/Users/marvin/var/tmp/claw')).toBe(false)
  })

  it('handles a trailing slash the same way', () => {
    expect(isTmpRootedPath('/private/tmp/x/')).toBe(true)
    expect(isTmpRootedPath('/Users/marvin/x/')).toBe(false)
  })
})

describe('the two guards share one list (anti-drift)', () => {
  it('every prefix the root gate refuses, the hook-command guard also refuses', () => {
    for (const p of TMP_ROOT_PREFIXES) {
      expect(isTmpRootedPath(`${p}c`), `root gate: ${p}`).toBe(true)
      expect(isUnsafeHookCommand(`python3 ${p}hooks/guard.py`), `hook guard: ${p}`).toBe(true)
    }
  })
})
