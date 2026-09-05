import { describe, it, expect } from 'vitest'
import { mergeIsolatedHooks, hookEntryId, isDurableIsolatedHook } from '../web/agent-process.js'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REAL_HOOK = join(ROOT, 'scripts', 'hooks', 'ledger-replay.py')
const REAL_HOOK_2 = join(ROOT, 'scripts', 'hooks', 'inbox-drain.py')

describe('hookEntryId', () => {
  it('identifies command and agent hooks, rejects the rest', () => {
    expect(hookEntryId({ type: 'command', command: 'a.py' })).toBe('command a.py')
    expect(hookEntryId({ type: 'agent', prompt: 'do x' })).toBe('agent do x')
    expect(hookEntryId({ type: 'command', command: '   ' })).toBeNull()
    expect(hookEntryId('nope')).toBeNull()
  })
})

describe('mergeIsolatedHooks', () => {
  const shared = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'shared.py' }] }] }

  it('returns shared untouched when the isolated file has no hooks', () => {
    expect(mergeIsolatedHooks(shared, undefined).hooks).toBe(shared)
  })

  it('adds isolated-only entries and reports them', () => {
    const own = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'own.py' }] }] }
    const r = mergeIsolatedHooks(shared, own)
    const cmds = (r.hooks!.UserPromptSubmit as any[]).flatMap((g) => g.hooks).map((h) => h.command)
    expect(cmds).toEqual(['shared.py', 'own.py'])
    expect(r.kept).toEqual(['UserPromptSubmit:own.py'])
  })

  it('does not mutate the shared object', () => {
    const own = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'own.py' }] }] }
    mergeIsolatedHooks(shared, own)
    expect(shared.UserPromptSubmit[0].hooks).toHaveLength(1)
  })

  it('keeps a matcher group separate from a differently-matched one', () => {
    const s = { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 's.py' }] }] }
    const own = { SessionStart: [{ matcher: 'clear', hooks: [{ type: 'command', command: 'c.py' }] }] }
    const groups = mergeIsolatedHooks(s, own).hooks!.SessionStart as any[]
    expect(groups).toHaveLength(2)
    expect(groups[1].matcher).toBe('clear')
  })
})

// ---------------------------------------------------------------------------
// The upgrade path: an entry retained in an isolated config is no longer
// rewritten by the path that heals it, so a stale one must not survive the
// merge at all. Two failure modes, both permanent once they land.
// ---------------------------------------------------------------------------
describe('isDurableIsolatedHook', () => {
  it('keeps an entry whose paths all exist inside the install', () => {
    expect(isDurableIsolatedHook({ type: 'command', command: `python3 ${REAL_HOOK}` })).toBe(true)
  })

  it('keeps a path-free entry (nothing to go stale)', () => {
    expect(isDurableIsolatedHook({ type: 'command', command: 'echo hi' })).toBe(true)
  })

  // The zombie: a version-pinned interpreter that stopped resolving after an
  // upgrade. The hook fails CLOSED, so retaining it blocks every call.
  it('drops an entry whose pinned interpreter no longer exists', () => {
    const cmd = `test -x "/usr/lib/node-22.3.0/bin/node" || exit 2; node ${REAL_HOOK}`
    expect(isDurableIsolatedHook({ type: 'command', command: cmd })).toBe(false)
  })

  it('drops an entry whose own script no longer exists', () => {
    expect(isDurableIsolatedHook({
      type: 'command',
      command: `python3 ${join(ROOT, 'scripts', 'hooks', 'removed-by-an-upgrade.py')}`,
    })).toBe(false)
  })

  it('drops a /tmp-rooted entry', () => {
    expect(isDurableIsolatedHook({ type: 'command', command: 'python3 /tmp/staging/hook.py' })).toBe(false)
  })

  // A worktree lives under $HOME, so "somewhere in home" would not catch it.
  it('drops a script in a git worktree outside the install', () => {
    const wt = join(homedir(), 'marveen-review-copy', 'scripts', 'hooks', 'ledger-replay.py')
    expect(isDurableIsolatedHook({ type: 'command', command: `python3 ${wt}` })).toBe(false)
  })

  // The blind spot found in review (2026-09-03): the common operator shape is a
  // hook body that names its script through a variable. The tail of such a body
  // looks like an absolute path but exists nowhere, so judging it literally
  // dropped the entry -- the very disappearance this merge prevents.
  it('keeps an entry whose script path comes from a variable', () => {
    for (const cmd of [
      'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/outgoing-copy-gate.py"',
      'python3 "${CLAUDE_PROJECT_DIR}/scripts/hooks/outgoing-copy-gate.py"',
      'bash $HOME/.claude/hooks/notify.sh',
      'node "$(dirname "$0")/../hooks/gate.mjs"',
    ]) {
      expect(isDurableIsolatedHook({ type: 'command', command: cmd })).toBe(true)
    }
  })

  // Skipping the unresolvable half must not soften the literal half: a body that
  // ALSO pins an interpreter that no longer exists is still a zombie.
  it('still drops a variable-pathed entry whose literal interpreter is gone', () => {
    const cmd = 'test -x "/usr/lib/node-22.3.0/bin/node" || exit 2; node "$CLAUDE_PROJECT_DIR/scripts/hooks/gate.mjs"'
    expect(isDurableIsolatedHook({ type: 'command', command: cmd })).toBe(false)
  })

  // A variable is not a way around the transient-root rule either, when the
  // transient part is stated literally.
  it('still drops a literal /tmp path that sits beside a variable one', () => {
    const cmd = 'python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/gate.py" --aux /tmp/staging/helper.py'
    expect(isDurableIsolatedHook({ type: 'command', command: cmd })).toBe(false)
  })
})

describe('mergeIsolatedHooks upgrade path', () => {
  it('does not carry a stale isolated entry into the merged config', () => {
    const shared = { PreToolUse: [{ hooks: [{ type: 'command', command: `python3 ${REAL_HOOK}` }] }] }
    const own = {
      PreToolUse: [{
        hooks: [{
          type: 'command',
          command: `test -x "/usr/lib/node-22.3.0/bin/node" || exit 2; node ${REAL_HOOK_2}`,
        }],
      }],
    }
    const r = mergeIsolatedHooks(shared, own)
    const cmds = (r.hooks!.PreToolUse as any[]).flatMap((g) => g.hooks).map((h) => h.command)
    expect(cmds).toEqual([`python3 ${REAL_HOOK}`])
    expect(r.kept).toEqual([])
  })

  // Supersede by basename: the shared side owns the current variant of a hook,
  // so an older isolated variant of the SAME script does not survive next to it
  // even though both paths resolve.
  it('lets a newer shared entry supersede an older isolated variant', () => {
    const shared = { PreToolUse: [{ hooks: [{ type: 'command', command: `python3 ${REAL_HOOK}` }] }] }
    const own = {
      PreToolUse: [{ hooks: [{ type: 'command', command: `python3.11 ${REAL_HOOK} --legacy` }] }],
    }
    const r = mergeIsolatedHooks(shared, own)
    const cmds = (r.hooks!.PreToolUse as any[]).flatMap((g) => g.hooks).map((h) => h.command)
    expect(cmds).toEqual([`python3 ${REAL_HOOK}`])
    expect(r.kept).toEqual([])
  })

  it('still keeps a durable isolated-only hook the shared file never mentions', () => {
    const shared = { PreToolUse: [{ hooks: [{ type: 'command', command: `python3 ${REAL_HOOK}` }] }] }
    const own = { PreToolUse: [{ hooks: [{ type: 'command', command: `python3 ${REAL_HOOK_2}` }] }] }
    const r = mergeIsolatedHooks(shared, own).hooks!.PreToolUse as any[]
    const cmds = r.flatMap((g) => g.hooks).map((h) => h.command)
    expect(cmds).toEqual([`python3 ${REAL_HOOK}`, `python3 ${REAL_HOOK_2}`])
  })
})
