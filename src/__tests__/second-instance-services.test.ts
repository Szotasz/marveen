// Samu 64702: a second instance (worktree checkout, temp-dir clone) runs no background services,
// as if WEB_ONLY were set, unless its own .env opts in. The incident: 2026-11-01 15:23 a worktree
// instance without WEB_ONLY fired two of the live fleet's scheduled tasks into live sessions.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldRunBackgroundServices, ALLOW_SECOND_INSTANCE_SERVICES_KEY } from '../web/hook-registration-guard.js'

const notAGitFile = () => false

describe('shouldRunBackgroundServices', () => {
  it('the install itself runs them', () => {
    expect(shouldRunBackgroundServices({ projectRoot: '/Users/x/ClaudeClaw', webOnly: false, allowSecondInstance: false, isGitFile: notAGitFile, tmpDir: '/var/folders/ab/T' }))
      .toEqual({ run: true })
  })

  it('WEB_ONLY turns them off, the opt-in included', () => {
    for (const allowSecondInstance of [false, true]) {
      const d = shouldRunBackgroundServices({ projectRoot: '/Users/x/ClaudeClaw', webOnly: true, allowSecondInstance, isGitFile: notAGitFile })
      expect(d).toEqual({ run: false, reason: 'WEB_ONLY staging mode' })
    }
  })

  it('every second-instance kind is off without the opt-in', () => {
    const cases = [
      { projectRoot: '/Users/x/ClaudeClaw/.claude/worktrees/agent-1', isGitFile: notAGitFile }, // worktree path
      { projectRoot: '/Users/x/abel-wt-bridgemeasure', isGitFile: () => true }, // linked worktree (.git is a file)
      { projectRoot: '/private/tmp/marveen-work', isGitFile: notAGitFile }, // temp root
      { projectRoot: '/var/folders/ab/T/clone', isGitFile: notAGitFile, tmpDir: '/var/folders/ab/T' },
    ]
    for (const c of cases) {
      const d = shouldRunBackgroundServices({ ...c, webOnly: false, allowSecondInstance: false })
      expect(d.run, c.projectRoot).toBe(false)
      expect(d.reason, c.projectRoot).toMatch(/worktree|temp dir/)
      expect(d.override, c.projectRoot).toBeUndefined()
    }
  })

  it('a second instance with the opt-in runs them, and says it is an override', () => {
    const d = shouldRunBackgroundServices({ projectRoot: '/Users/x/abel-wt-bridgemeasure', webOnly: false, allowSecondInstance: true, isGitFile: () => true })
    expect(d).toEqual({ run: true, override: true, reason: expect.stringMatching(/worktree/) })
  })
})

describe('web.ts wiring (source pins)', () => {
  const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8').replace(/^\s*\/\/.*$/gm, '')
  const decision = src.indexOf('const services = shouldRunBackgroundServices(')
  const servicesOff = src.indexOf('const servicesOff = !services.run')
  const backfill = src.indexOf('const hookDecision = shouldRegisterHooks(')

  it('the decision reads the opt-in from the process environment, as WEB_ONLY, and comes before every service', () => {
    expect(ALLOW_SECOND_INSTANCE_SERVICES_KEY).toBe('MARVEEN_ALLOW_SECOND_INSTANCE_SERVICES')
    expect(decision).toBeGreaterThan(-1)
    expect(src.slice(decision, servicesOff)).toContain("allowSecondInstance: process.env[ALLOW_SECOND_INSTANCE_SERVICES_KEY] === '1'")
    expect(src).toContain("const webOnly = process.env['WEB_ONLY'] === 'true'")
    expect(src.slice(decision, servicesOff)).not.toContain('readEnvFile')
    expect(src.slice(decision, servicesOff)).toContain('webOnly')
    expect(servicesOff).toBeGreaterThan(decision)
    expect(src.indexOf('startMessageRouter()')).toBeGreaterThan(servicesOff)
  })

  it('the schedule runner, the router and the worker pre-start sit behind servicesOff', () => {
    expect(src).toContain('const scheduleInterval = servicesOff ? undefined : startScheduleRunner()')
    expect(src).toContain('const routerInterval = servicesOff ? undefined : startMessageRouter()')
    expect(src).toContain('const heartbeatGapInterval = servicesOff ? undefined : startHeartbeatGapGuard()')
    expect(src.match(/startScheduleRunner\(\)/g)).toHaveLength(1)
    expect(src.match(/startMessageRouter\(\)/g)).toHaveLength(1)
    expect(src.match(/startWorkerSession\(\)/g)?.length ?? 0).toBeGreaterThan(0)
    for (const m of src.matchAll(/startWorkerSession\(\)/g)) {
      expect(src.lastIndexOf('if (!servicesOff', m.index)).toBeGreaterThan(servicesOff)
    }
  })

  it('the orphan background-task sweep (it kills tmux sessions) sits behind servicesOff (Dani 64963)', () => {
    const call = src.indexOf('    sweepOrphanedBackgroundTasks().catch(')
    expect(call).toBeGreaterThan(servicesOff)
    const gate = '  if (!servicesOff) {\n'
    expect(src.lastIndexOf(gate, call)).toBe(call - gate.length)
    expect(src.match(/sweepOrphanedBackgroundTasks\(\)/g)).toHaveLength(1)
  })

  it('no service between the decision and the hook backfill is gated by webOnly alone', () => {
    const firstService = src.indexOf('const routerInterval =')
    expect(firstService).toBeGreaterThan(servicesOff)
    expect(backfill).toBeGreaterThan(firstService)
    expect(src.slice(firstService, backfill)).not.toMatch(/\bwebOnly\b/)
  })
})
