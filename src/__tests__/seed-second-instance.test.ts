import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldRegisterHooks } from '../web/hook-registration-guard.js'

// 2026-11-01 15:23 (Ábel 64492, Dani 64510): a test dashboard started from a git worktree ran the default
// scheduled-task seed, which writes the user-global scheduled tasks dir and reads the "removed default" tombstones
// from the instance's OWN store, so a second instance could write back a default the owner deleted. The seed now
// follows the same second-instance decision as the hook registration: a worktree, a temp root or WEB_ONLY never seeds.

const web = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')

describe('the default task seed runs only in the instance that owns the install', () => {
  it('the seed call sits inside the hook decision\'s register branch, after the decision', () => {
    const decision = web.indexOf('const hookDecision = shouldRegisterHooks(')
    const guard = web.indexOf('  if (!hookDecision.register) {\n    logger.info({ reason: hookDecision.reason }, \'Default scheduled tasks not seeded (second instance)\')\n  } else {')
    const call = web.indexOf('      ensureDefaultScheduledTasks()')
    expect(decision).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(decision)
    expect(call).toBeGreaterThan(guard)
    // One call site only: no other path seeds outside the guard.
    expect(web.split('ensureDefaultScheduledTasks()').length - 1).toBe(1)
  })

  it('the rotation heartbeat seed sits in the same register branch (Dani 64715: the same class)', () => {
    const guard = web.indexOf('  if (!hookDecision.register) {\n    logger.info({ reason: hookDecision.reason }, \'Default scheduled tasks not seeded (second instance)\')\n  } else {')
    const call = web.indexOf('      const seeded = ensureRotationHeartbeatTask({ respectRemoval: true })')
    // The branch ends right before the orphan sweep (since #2419 behind its own servicesOff gate).
    const branchEnd = web.indexOf('\n  }\n\n  // The orphan sweep kills', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(guard)
    expect(branchEnd).toBeGreaterThan(call)
    // The else branch holds no closing brace at its own indent before the call: the call is inside it.
    expect(web.slice(guard, call).split('\n  }\n').length - 1).toBe(0)
    expect(web.split('ensureRotationHeartbeatTask(').length - 1).toBe(1)
  })

  it('every second-instance kind says no (the decision the seed now follows)', () => {
    const notAGitFile = () => false
    expect(shouldRegisterHooks({ projectRoot: '/Users/x/repo/.claude/worktrees/wt1', webOnly: false, isGitFile: notAGitFile }).register).toBe(false)
    expect(shouldRegisterHooks({ projectRoot: '/Users/x/abel-wt-bridgemeasure', webOnly: false, isGitFile: () => true }).register).toBe(false)
    expect(shouldRegisterHooks({ projectRoot: '/private/tmp/canary', webOnly: false, isGitFile: notAGitFile, tmpDir: '/var/folders/zz/T' }).register).toBe(false)
    expect(shouldRegisterHooks({ projectRoot: '/Users/x/ClaudeClaw', webOnly: true, isGitFile: notAGitFile, tmpDir: '/var/folders/zz/T' }).register).toBe(false)
    // The install itself still seeds.
    expect(shouldRegisterHooks({ projectRoot: '/Users/x/ClaudeClaw', webOnly: false, isGitFile: notAGitFile, tmpDir: '/var/folders/zz/T' }).register).toBe(true)
  })
})
