import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PRECHECK_MAX_TIMEOUT_MS,
  PRECHECK_MIN_TIMEOUT_MS,
  PRECHECK_TIMEOUT_MS,
  preCheckCwd,
  resolvePreCheckTimeoutMs,
  runPreCheck,
  runPreCheckAsync,
} from '../web/schedule-runner.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// PRECHECKCWD1027. Two gaps in the pre-check gate, both measured before
// this change:
//
// 1. cwd. The script inherited the DASHBOARD's working directory, so a
//    pre-check that derives whose state it reads from the cwd read the main
//    agent's state whatever agent the task targeted. ledger-live-drain.py is
//    exactly that shape (ledger_lib.agent_id_from_cwd(os.getcwd())); it is
//    deployed on the main agent today, where the wrong answer and the right
//    answer coincide -- which is why this sat unseen.
//
// 2. A fixed 10 s limit. A pre-check that crosses the network is killed on
//    every tick and fails open, so the gate costs a round trip and saves
//    nothing: the pre-check that prompted this opens an SSH session to a
//    remote host (ConnectTimeout 15, overall 30).

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name: 'test-task',
    description: 'test',
    prompt: 'Do something.',
    schedule: '0 * * * *',
    agent: MAIN_AGENT_ID,
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    ...overrides,
  }
}

function withScript(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-cwd-'))
  const file = join(dir, 'pre-check.sh')
  writeFileSync(file, content, { mode: 0o755 })
  return { dir, file }
}

describe('preCheckCwd', () => {
  // A real agent directory, because the fallback below is keyed on existence.
  const AGENT = 'precheck-cwd-fixture'
  beforeAll(() => { mkdirSync(agentDir(AGENT), { recursive: true }) })
  afterAll(() => { rmSync(agentDir(AGENT), { recursive: true, force: true }) })

  it('uses the target agent directory, not the dashboard cwd', () => {
    expect(preCheckCwd({ agent: AGENT })).toBe(agentDir(AGENT))
    expect(agentDir(AGENT)).not.toBe(PROJECT_ROOT)
  })

  it('runs the script in the target agent directory, in both forms', () => {
    const { dir, file } = withScript('#!/bin/bash\npwd\n')
    try {
      const task = makeTask({ agent: AGENT, preCheck: file })
      expect(runPreCheck(task).prefix).toBe(agentDir(AGENT))
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('uses the project root for the main agent and when agent is unset', () => {
    expect(preCheckCwd({ agent: MAIN_AGENT_ID })).toBe(PROJECT_ROOT)
    expect(preCheckCwd({ agent: '' })).toBe(PROJECT_ROOT)
  })

  it("keeps the project root for a broadcast ('all') task", () => {
    // The cron loop runs the gate ONCE per task, so a broadcast has no single
    // agent directory to name; picking one of them would be a guess.
    expect(preCheckCwd({ agent: 'all' })).toBe(PROJECT_ROOT)
  })

  it('falls back to the project root when the agent directory is gone', () => {
    // An absent cwd makes spawn fail with ENOENT, and this file treats a spawn
    // error as fail-open -- so without the fallback a task pointed at a
    // deleted agent would stop being gated and run the LLM on every tick.
    expect(preCheckCwd({ agent: 'no-such-agent-precheckcwd' })).toBe(PROJECT_ROOT)
  })

  it('runs a main-agent task in the project root, in both forms', async () => {
    const { dir, file } = withScript('#!/bin/bash\npwd\n')
    try {
      const task = makeTask({ preCheck: file })
      expect(runPreCheck(task).prefix).toBe(PROJECT_ROOT)
      expect((await runPreCheckAsync(task)).prefix).toBe(PROJECT_ROOT)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('passes a cwd at every spawn call site', () => {
    // Placement, not behaviour: a future call site that forgets cwd reopens
    // gap 1 for whichever script it runs.
    for (const call of SRC.match(/spawn(?:Sync)?\('bash', inv\.args, \{[^}]*\}/g) ?? []) {
      expect(call).toContain('cwd: preCheckCwd(task)')
    }
    expect(SRC.match(/spawn(?:Sync)?\('bash', inv\.args/g)?.length).toBe(2)
  })
})

describe('resolvePreCheckTimeoutMs', () => {
  it('defaults to the 10 s limit when unset', () => {
    expect(resolvePreCheckTimeoutMs(makeTask())).toBe(PRECHECK_TIMEOUT_MS)
  })

  it('honours a configured value in seconds', () => {
    expect(resolvePreCheckTimeoutMs(makeTask({ preCheckTimeoutSeconds: 30 }))).toBe(30_000)
  })

  it('clamps to the ceiling so one gate cannot hold the next tick for long', () => {
    expect(resolvePreCheckTimeoutMs(makeTask({ preCheckTimeoutSeconds: 600 }))).toBe(PRECHECK_MAX_TIMEOUT_MS)
  })

  it('clamps up to the floor so the gate is never pure cost', () => {
    expect(resolvePreCheckTimeoutMs(makeTask({ preCheckTimeoutSeconds: 0.1 }))).toBe(PRECHECK_MIN_TIMEOUT_MS)
  })

  it('takes the default for a non-positive or non-finite value', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolvePreCheckTimeoutMs(makeTask({ preCheckTimeoutSeconds: bad }))).toBe(PRECHECK_TIMEOUT_MS)
    }
    expect(resolvePreCheckTimeoutMs(makeTask({ preCheckTimeoutSeconds: ' 30' as unknown as number }))).toBe(PRECHECK_TIMEOUT_MS)
  })

  it('kills a script that overruns the task limit, and fails open', async () => {
    const { dir, file } = withScript('#!/bin/bash\nsleep 5\necho SKIP\n')
    try {
      const started = Date.now()
      const res = await runPreCheckAsync(makeTask({ preCheck: file, preCheckTimeoutSeconds: 1 }))
      // Fail-open: an unfinished gate must never stand in for a SKIP.
      expect(res).toEqual({ skip: false })
      expect(Date.now() - started).toBeLessThan(4_000)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('lets a script finish inside a raised limit that the 10 s default allows too', async () => {
    const { dir, file } = withScript('#!/bin/bash\nsleep 0.2\necho SKIP\n')
    try {
      const res = await runPreCheckAsync(makeTask({ preCheck: file, preCheckTimeoutSeconds: 30 }))
      expect(res).toEqual({ skip: true })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
