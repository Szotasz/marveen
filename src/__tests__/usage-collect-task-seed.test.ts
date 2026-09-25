import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveCommandPlaceholders } from '../web/command-task.js'
import { quotaWorkClass } from '../web/schedule-runner.js'

// The usage-collect default task feeds store/usage-latest.json (overview
// Fable/Opus row + the schedule-runner quota gate). It ships as a raw
// `type: "command"` task, not an LLM heartbeat: no model turn, no tmux, and
// quota class `free`, so the gate can never hold back the task that feeds it.
// It ships DISABLED: turning a new recurring default on for every install is a
// fleet-lead product decision, not something a seed makes silently.

const ROOT = join(__dirname, '..', '..')
const TASK_DIR = join(ROOT, 'scheduled-tasks', 'usage-collect')
const cfg = () => JSON.parse(readFileSync(join(TASK_DIR, 'task-config.json'), 'utf-8'))

describe('usage-collect scheduled-task seed', () => {
  it('ships as a config-only command task (no SKILL.md prompt)', () => {
    expect(readdirSync(TASK_DIR)).toEqual(['task-config.json'])
    expect(cfg().type).toBe('command')
  })

  it('is disabled by default', () => {
    expect(cfg().enabled).toBe(false)
  })

  it('runs in the free quota class, never gated as background work', () => {
    expect(quotaWorkClass({ type: cfg().type })).toBe('free')
  })

  it('names no chat and no owner channel (alerts go through command-task)', () => {
    const raw = readFileSync(join(TASK_DIR, 'task-config.json'), 'utf-8')
    expect(raw).not.toMatch(/chat_id/)
  })

  it('invokes the shipped script via the install-root placeholder, with a timeout above its runtime', () => {
    const c = cfg()
    expect(c.command).toBe('python3 {{PROJECT_ROOT}}/scripts/usage-collect.py')
    expect(existsSync(join(ROOT, 'scripts', 'usage-collect.py'))).toBe(true)
    expect(c.timeoutMs).toBeGreaterThan(10_000)
    expect(typeof c.agent).toBe('string')
  })
})

describe('resolveCommandPlaceholders', () => {
  it('resolves both install-root placeholders, shell-quoted, everywhere in the command', () => {
    expect(resolveCommandPlaceholders('python3 {{PROJECT_ROOT}}/a.py', '/opt/m'))
      .toBe("python3 '/opt/m'/a.py")
    expect(resolveCommandPlaceholders('cd {{INSTALL_DIR}} && x {{PROJECT_ROOT}}/y', '/r'))
      .toBe("cd '/r' && x '/r'/y")
  })

  it('leaves a command without placeholders untouched', () => {
    expect(resolveCommandPlaceholders('df -h /', '/r')).toBe('df -h /')
  })

  it('keeps a root with spaces and quotes a single shell word', () => {
    const cmd = resolveCommandPlaceholders('printf %s {{PROJECT_ROOT}}/x', "/tmp/a b'c")
    const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf-8' })
    expect(r.stdout).toBe("/tmp/a b'c/x")
  })
})
