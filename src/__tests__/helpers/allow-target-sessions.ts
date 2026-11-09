// OWNEREXEC1109: the scheduler types a prompt only into a fleet session (allowedTargetSessions in schedule-runner.ts).
// Runner suites that route their fixtures by a made-up targetSession ('ws-session', 'retry-test-session', ...) list
// exactly those names here. The list lives on a global symbol, so a suite that re-imports the runner (vi.resetModules)
// still sees it, and it is cleared after the file. Production code never sets it. The suites that test the guard
// itself (schedule-target-session-guard, schedule-registry-runner-tick) do not use this.
import { afterAll } from 'vitest'

export const TARGET_SESSION_TEST_ALLOW = Symbol.for('marveen.schedule.targetSessionAllowForTest')

export function allowTargetSessionsForTest(names: string[]): void {
  ;(globalThis as Record<symbol, unknown>)[TARGET_SESSION_TEST_ALLOW] = new Set(names)
  afterAll(() => { delete (globalThis as Record<symbol, unknown>)[TARGET_SESSION_TEST_ALLOW] })
}
