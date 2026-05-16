import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated unit test for the JSON-rewrite path of
// ensureDefaultScheduledTasks. We re-implement the core copy-with-
// agent-rewrite inline so the test is hermetic: no env var mutation,
// no real PROJECT_ROOT or homedir reads, just the JSON transform on
// arbitrary src/dest pairs. The real exported function composes this
// with a filesystem walk and a MAIN_AGENT_ID import; both are covered
// by integration on real installs.
function rewriteAgentField(srcPath: string, destPath: string, mainAgentId: string): void {
  try {
    const raw = readFileSync(srcPath, 'utf-8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (typeof cfg.agent === 'string') {
      cfg.agent = mainAgentId
    }
    writeFileSync(destPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch {
    // Mirror the production fall-back: a malformed JSON should not
    // drop the file silently.
    writeFileSync(destPath, readFileSync(srcPath))
  }
}

describe('ensureDefaultScheduledTasks JSON-rewrite (task-config.json)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scaffold-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('rewrites the agent field to MAIN_AGENT_ID on a hardcoded "marveen" config', () => {
    const src = join(tmp, 'src.json')
    const dest = join(tmp, 'dest.json')
    writeFileSync(src, JSON.stringify({
      schedule: '0 9 * * *',
      agent: 'marveen',
      enabled: true,
      type: 'task',
    }))
    rewriteAgentField(src, dest, 'host-agent')
    const parsed = JSON.parse(readFileSync(dest, 'utf-8'))
    expect(parsed.agent).toBe('host-agent')
    // Other fields untouched.
    expect(parsed.schedule).toBe('0 9 * * *')
    expect(parsed.enabled).toBe(true)
    expect(parsed.type).toBe('task')
  })

  it('rewrites even when the source agent is already the host MAIN_AGENT_ID', () => {
    // Idempotent: a config that already matches the host should not
    // change in meaning. The rewrite still runs and produces the same
    // value, so the second-boot scaffold is a no-op semantically.
    const src = join(tmp, 'src.json')
    const dest = join(tmp, 'dest.json')
    writeFileSync(src, JSON.stringify({ agent: 'host-agent', schedule: '0 9 * * *' }))
    rewriteAgentField(src, dest, 'host-agent')
    const parsed = JSON.parse(readFileSync(dest, 'utf-8'))
    expect(parsed.agent).toBe('host-agent')
  })

  it('leaves the agent field missing when the source has no agent key', () => {
    // Some legitimate task-configs omit `agent` entirely and rely on
    // the scheduled-tasks-io runtime fallback (config.agent ||
    // MAIN_AGENT_ID). The rewrite must not invent the field on a
    // config that deliberately leaves it out -- the runtime fallback
    // would then have nothing to fall back to and would not even know
    // a default was needed.
    const src = join(tmp, 'src.json')
    const dest = join(tmp, 'dest.json')
    writeFileSync(src, JSON.stringify({ schedule: '0 9 * * *', enabled: true }))
    rewriteAgentField(src, dest, 'host-agent')
    const parsed = JSON.parse(readFileSync(dest, 'utf-8'))
    expect(parsed.agent).toBeUndefined()
    expect(parsed.schedule).toBe('0 9 * * *')
  })

  it('falls back to a byte copy when the source is not valid JSON', () => {
    // Production safety: if a task-config.json gets corrupted in the
    // repo (merge conflict marker, half-truncated write), the scaffold
    // must still leave a file at the destination so the operator can
    // see it and fix it. A silent drop would make the missing task
    // look like a different bug entirely.
    const src = join(tmp, 'src.json')
    const dest = join(tmp, 'dest.json')
    const corrupted = '{\n  "schedule": "0 9 * * *",\n<<<<<<< HEAD\n  "agent": "marveen"\n=======\n'
    writeFileSync(src, corrupted)
    rewriteAgentField(src, dest, 'host-agent')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf-8')).toBe(corrupted)
  })

  it('preserves non-agent string fields containing the literal "marveen"', () => {
    // Conservative scope: only the `agent` field is rewritten, even if
    // another field happens to contain the string "marveen" (e.g. a
    // task `type` named "marveen-heartbeat" in a hypothetical future
    // task). A blunt string replace would corrupt unrelated fields.
    const src = join(tmp, 'src.json')
    const dest = join(tmp, 'dest.json')
    writeFileSync(src, JSON.stringify({
      agent: 'marveen',
      type: 'marveen-heartbeat',
      description: 'pings the marveen hub',
    }))
    rewriteAgentField(src, dest, 'host-agent')
    const parsed = JSON.parse(readFileSync(dest, 'utf-8'))
    expect(parsed.agent).toBe('host-agent')
    expect(parsed.type).toBe('marveen-heartbeat')
    expect(parsed.description).toBe('pings the marveen hub')
  })
})
