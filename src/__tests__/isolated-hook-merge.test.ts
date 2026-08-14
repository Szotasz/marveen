import { describe, it, expect } from 'vitest'
import { mergeIsolatedHooks, hookEntryId } from '../web/agent-process.js'

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
