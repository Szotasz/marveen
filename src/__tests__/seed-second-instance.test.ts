import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

  // PLANROTATEDEADLOCK1115 P5: the old rotation task is no longer seeded; its retirement took the seed's place, in the
  // same register branch (it removes or rewrites a task in the user-global dir: the same class, Dani 64715), and only
  // with the background services on.
  it('the rotation task retirement sits in the same register branch, behind the services gate', () => {
    const guard = web.indexOf('  if (!hookDecision.register) {\n    logger.info({ reason: hookDecision.reason }, \'Default scheduled tasks not seeded (second instance)\')\n  } else {')
    const gate = web.indexOf('    if (!servicesOff) {\n      void withRotationLock(() => retireRotationHeartbeatTask(defaultRotationBackendDeps()))', guard)
    // The branch ends right before the orphan sweep (since #2419 behind its own servicesOff gate).
    const branchEnd = web.indexOf('\n  }\n\n  // The orphan sweep kills', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(guard)
    expect(branchEnd).toBeGreaterThan(gate)
    expect(web.slice(guard, gate).split('\n  }\n').length - 1).toBe(0)
    expect(web.split('retireRotationHeartbeatTask(').length - 1).toBe(1)
  })

  it('no former seed path calls the rotation task seeders any more (startup, Settings toggle, any other source)', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p) } else if (e.name.endsWith('.ts')) files.push(p)
      }
    }
    walk(join(__dirname, '..'))
    walk(join(__dirname, '..', '..', 'scripts'))
    const callers = files
      .filter((f) => !f.endsWith(join('web', 'claude-rotation-heartbeat.ts')))
      .filter((f) => /\b(ensureRotationHeartbeatTask|syncRotationHeartbeatTask)\b/.test(readFileSync(f, 'utf-8')))
    expect(files.length).toBeGreaterThan(100)
    expect(callers).toEqual([])
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
