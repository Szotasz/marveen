import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// docs/conversation-continuity.md promises that ledger-live-drain.py is "run
// every ~2 min by the ledger-live-drain scheduled task" -- but no such task was
// ever shipped: scheduled-tasks/ only seeded dream-engine, memoria-heartbeat
// and reggeli-napindito, so the drain NEVER ran and the mid-session deafness
// gap it exists to close stayed open. Same dead-feature class as the
// skill-usage-capture registration gap: tested logic, zero production wiring.
// These tests pin the promise to the seed.

const ROOT = join(__dirname, '..', '..')
const TASK_DIR = join(ROOT, 'scheduled-tasks', 'ledger-live-drain')

describe('ledger-live-drain scheduled-task seed', () => {
  it('the task the docs promise is actually shipped', () => {
    expect(existsSync(join(TASK_DIR, 'task-config.json'))).toBe(true)
    expect(existsSync(join(TASK_DIR, 'SKILL.md'))).toBe(true)
  })

  it('config parses, is enabled, and runs on the ~2-minute cadence the docs state', () => {
    const cfg = JSON.parse(readFileSync(join(TASK_DIR, 'task-config.json'), 'utf-8'))
    expect(cfg.enabled).toBe(true)
    expect(cfg.schedule).toBe('*/2 * * * *')
    // Seeded for the main agent; copyTaskConfigWithAgentRewrite() rewrites this
    // to the install's MAIN_AGENT_ID, but only when the field is a string.
    expect(typeof cfg.agent).toBe('string')
  })

  it('the prompt invokes the drain script via the placeholder the seeder resolves', () => {
    const skill = readFileSync(join(TASK_DIR, 'SKILL.md'), 'utf-8')
    expect(skill).toContain('{{PROJECT_ROOT}}/scripts/hooks/ledger-live-drain.py')
  })

  it('the drain script the task invokes exists', () => {
    expect(existsSync(join(ROOT, 'scripts', 'hooks', 'ledger-live-drain.py'))).toBe(true)
  })
})
