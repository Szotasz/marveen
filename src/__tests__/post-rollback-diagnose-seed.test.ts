import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the seeded post-rollback diagnosis task (PR-D). It is an on-demand-only
// task (enabled:false so cron never fires it) that the guarded
// POST /api/updates/diagnose endpoint triggers. These assertions lock its
// dormant shape and its structural guardrails into the delivered prompt.
const DIR = join(__dirname, '..', '..', 'seed-scheduled-tasks', 'post-rollback-diagnose')
const config = JSON.parse(readFileSync(join(DIR, 'task-config.json'), 'utf-8')) as {
  agent: string; enabled: boolean; type: string
}
const skill = readFileSync(join(DIR, 'SKILL.md'), 'utf-8')

describe('post-rollback-diagnose seed task', () => {
  it('is a dormant (enabled:false) LLM task on the main agent placeholder', () => {
    expect(config.type).toBe('task')
    expect(config.enabled).toBe(false)
    expect(config.agent).toBe('{{MAIN_AGENT_ID}}')
  })

  it('encodes the structural guardrails in the delivered prompt', () => {
    // no force-push, stash-not-drop, verify build, report back
    expect(skill).toMatch(/force-push/i)
    expect(skill).toMatch(/git stash/i)
    expect(skill).toMatch(/npm run build/i)
    expect(skill).toMatch(/update\.sh/)
  })

  it('uses placeholders, never a hardcoded absolute path or agent name', () => {
    expect(skill).toContain('{{INSTALL_DIR}}')
    expect(skill).not.toMatch(/\/Users\/|\/home\//)
  })
})
