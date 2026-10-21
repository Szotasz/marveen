// The registry hash (preCheckHashTarget, scheduled-tasks-io.ts) and the runner
// (resolvePreCheckPath, schedule-runner.ts) must read a task's preCheck by the
// same rule: the script the runner executes is the script the hash covers,
// unless it is repo-shipped code (isRepoShippedScript), and a value that is no
// script for the hash is no script for the runner either. Both now call
// preCheckScriptPath (precheck-path.ts).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { tmpHome, realHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-path-home-'))
  const prev = process.env.HOME
  process.env.HOME = dir
  return { tmpHome: dir, realHome: prev }
})

const mockWarn = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

import { PROJECT_ROOT } from '../config.js'
import { SCHEDULED_TASKS_DIR, preCheckHashTarget, type ScheduledTask } from '../web/scheduled-tasks-io.js'
import { resolvePreCheckPath, runPreCheck, runPreCheckAsync } from '../web/schedule-runner.js'

const TASK = 'pc-task'
const taskDir = join(SCHEDULED_TASKS_DIR, TASK)

function makeTask(preCheck: unknown): ScheduledTask {
  return {
    name: TASK, dirName: TASK, description: 'test', prompt: 'Do something.', schedule: '0 * * * *',
    agent: 'agent', enabled: true, createdAt: 0, type: 'heartbeat', preCheck: preCheck as string,
  }
}

beforeEach(() => {
  mockWarn.mockClear()
  mkdirSync(taskDir, { recursive: true })
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('one preCheck path rule for the registry hash and the runner', () => {
  const repoShipped = '{{PROJECT_ROOT}}/scripts/prechecks/memoria-heartbeat-precheck.sh'
  const strings = [
    'pre.sh',
    'sub/pre.sh',
    '../other-task/pre.sh',
    '..pre.sh',
    '{{PROJECT_ROOT}}x',
    `${tmpHome}/abs/pre.sh`,
    '{{INSTALL_DIR}}/agents/x/pre.sh',
  ]

  it.each(strings)('%s: the script the runner runs is the one the hash covers', (form) => {
    const runs = resolvePreCheckPath(TASK, form)
    expect(runs).not.toBeNull()
    expect(preCheckHashTarget(taskDir, form)).toBe(runs)
  })

  it('a repo-shipped script: the runner runs it, the hash leaves it out', () => {
    expect(resolvePreCheckPath(TASK, repoShipped)).toBe(join(PROJECT_ROOT, 'scripts', 'prechecks', 'memoria-heartbeat-precheck.sh'))
    expect(preCheckHashTarget(taskDir, repoShipped)).toBeNull()
  })

  it.each([[true], [1], [['pre.sh']], [{ path: 'pre.sh' }], ['']])('%j is no script for either side', (value) => {
    expect(preCheckHashTarget(taskDir, value)).toBeNull()
    expect(resolvePreCheckPath(TASK, value)).toBeNull()
  })

  it('the runner treats a non-string preCheck as none: the LLM runs, nothing throws', async () => {
    expect(runPreCheck(makeTask(true))).toEqual({ skip: false })
    await expect(runPreCheckAsync(makeTask(['pre.sh']))).resolves.toEqual({ skip: false })
    expect(mockWarn.mock.calls.some(c => String(c[1]).includes('not a script path'))).toBe(true)
  })
})
