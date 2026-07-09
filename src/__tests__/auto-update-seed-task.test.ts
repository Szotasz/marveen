import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the seeded auto-update scheduled task (PR-C). It is a command-type
// (LLM-free) task that calls PR-B's robust update.sh weekly, but is OPT-IN:
// the command must no-op unless the operator sets AUTO_UPDATE_ENABLED=1 in
// .env. These assertions lock the safety-critical shape so an accidental edit
// cannot silently turn auto-update ON for every install or drop the gate.
const CONFIG_PATH = join(__dirname, '..', '..', 'seed-scheduled-tasks', 'auto-update', 'task-config.json')

interface TaskConfig {
  schedule: string
  agent: string
  enabled: boolean
  type: string
  description: string
  command: string
  timeoutMs: number
  failThreshold: number
  createdAt: number
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as TaskConfig

describe('auto-update seed task', () => {
  it('is a command-type task on the Wednesday 04:00 cron', () => {
    expect(config.type).toBe('command')
    expect(config.schedule).toBe('0 4 * * 3')
  })

  it('targets the main agent via the distribution placeholder (no hardcoded id)', () => {
    expect(config.agent).toBe('{{MAIN_AGENT_ID}}')
  })

  it('gates on AUTO_UPDATE_ENABLED and no-ops when it is not 1', () => {
    expect(config.command).toContain('AUTO_UPDATE_ENABLED=')
    // The gate must exit before ever launching update.sh.
    const gateIdx = config.command.indexOf('|| exit 0')
    const launchIdx = config.command.indexOf('update.sh')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(launchIdx).toBeGreaterThan(gateIdx)
  })

  it('calls PR-B update.sh with the notify flag, not its own update logic', () => {
    expect(config.command).toContain('MARVEEN_UPDATE_NOTIFY=1')
    expect(config.command).toContain('AUTO_STASH=1')
    expect(config.command).toContain('{{INSTALL_DIR}}/update.sh')
  })

  it('detaches portably (setsid on Linux, nohup fallback on macOS)', () => {
    expect(config.command).toContain('setsid')
    expect(config.command).toContain('nohup')
  })

  it('uses install-dir placeholders, never a hardcoded absolute path', () => {
    expect(config.command).toContain('{{INSTALL_DIR}}')
    expect(config.command).not.toMatch(/\/Users\/|\/home\//)
  })
})
