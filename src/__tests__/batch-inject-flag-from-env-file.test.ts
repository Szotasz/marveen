// B1F38C8C rollout flag resolution. MEASURED 2026-09-20 on the host: the
// dashboard's process.env (launchd) contains NONE of the install .env keys, so
// a flag read from process.env alone cannot be switched on through the
// documented path. The flag must resolve from the install .env as well --
// process.env still wins when set, so operator/test overrides keep working.
//
// env.ts pins PROJECT_ROOT at import time (CLAUDECLAW_ENV_DIR is its test
// seam), so each case re-imports the module after pointing the seam at a
// temporary .env.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const saved = {
  dir: process.env.CLAUDECLAW_ENV_DIR,
  agents: process.env.ROUTER_BATCH_INJECT_AGENTS,
  max: process.env.ROUTER_BATCH_INJECT_MAX,
}

async function loadWithEnvFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'b1f-env-'))
  writeFileSync(join(dir, '.env'), content)
  process.env.CLAUDECLAW_ENV_DIR = dir
  vi.resetModules()
  return await import('../web/batch-inject.js')
}

describe('ROUTER_BATCH_INJECT_* resolves from the install .env, not only from process.env', () => {
  beforeEach(() => {
    delete process.env.ROUTER_BATCH_INJECT_AGENTS
    delete process.env.ROUTER_BATCH_INJECT_MAX
  })
  afterAll(() => {
    for (const [k, v] of [
      ['CLAUDECLAW_ENV_DIR', saved.dir],
      ['ROUTER_BATCH_INJECT_AGENTS', saved.agents],
      ['ROUTER_BATCH_INJECT_MAX', saved.max],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    vi.resetModules()
  })

  it('the documented rollout step -- the flag in .env, nothing in process.env -- switches batching ON', async () => {
    const m = await loadWithEnvFile('ROUTER_BATCH_INJECT_AGENTS=Samu\nROUTER_BATCH_INJECT_MAX=3\n')
    expect(m.batchInjectCapFor('samu')).toBe(3)
    expect(m.batchInjectCapFor('geri')).toBe(0)
  })

  it('an empty .env leaves batching OFF (no silent default-on)', async () => {
    const m = await loadWithEnvFile('WEB_PORT=3420\n')
    expect(m.batchInjectCapFor('samu')).toBe(0)
  })

  it('process.env wins over the .env when set, and an empty process.env value does not mask the .env', async () => {
    const m = await loadWithEnvFile('ROUTER_BATCH_INJECT_AGENTS=samu\nROUTER_BATCH_INJECT_MAX=3\n')
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'geri'
    expect(m.batchInjectCapFor('samu')).toBe(0)
    expect(m.batchInjectCapFor('geri')).toBe(3)
    process.env.ROUTER_BATCH_INJECT_AGENTS = '   '
    expect(m.batchInjectCapFor('samu')).toBe(3)
  })

  it('the .env is read fresh on each call: editing it takes effect without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1f-env-'))
    writeFileSync(join(dir, '.env'), 'WEB_PORT=3420\n')
    process.env.CLAUDECLAW_ENV_DIR = dir
    vi.resetModules()
    const m = await import('../web/batch-inject.js')
    expect(m.batchInjectCapFor('samu')).toBe(0)
    writeFileSync(join(dir, '.env'), 'WEB_PORT=3420\nROUTER_BATCH_INJECT_AGENTS=samu\n')
    expect(m.batchInjectCapFor('samu')).toBe(m.BATCH_INJECT_MAX_DEFAULT)
  })
})
