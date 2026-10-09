/**
 * DEFAULTCLIGUARD927 (Szotasz review of #1609): the launch-time guard on the
 * DEFAULT model path of sub-agents, worker sessions and agent-create. The
 * shipped default is swapped for the previous tier only when (a) no operator
 * configured DEFAULT_AGENT_MODEL and (b) the installed CLI is MEASURED not to
 * run it. The main-agent path (shell + respawn) is pinned in
 * main-model-resolution-parity.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL, DISTRIBUTION_DEFAULT_FALLBACK_MODEL } from '../config-registry.js'
import { CLI_VERSION_OVERRIDE_ENV } from '../web/claude-cli-version.js'

const saved = process.env[CLI_VERSION_OVERRIDE_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]
  else process.env[CLI_VERSION_OVERRIDE_ENV] = saved
  vi.doUnmock('../config.js')
  vi.resetModules()
})
beforeEach(() => { vi.resetModules() })

/** Load the guard against a config whose DEFAULT_AGENT_MODEL is (or is not) operator-set. */
async function loadGuard(configured: string | null) {
  vi.doMock('../config.js', async (orig) => {
    const actual = await orig<typeof import('../config.js')>()
    return {
      ...actual,
      DEFAULT_AGENT_MODEL: configured ?? DISTRIBUTION_DEFAULT_AGENT_MODEL,
      DEFAULT_AGENT_MODEL_IS_DISTRIBUTION: configured === null,
    }
  })
  const guard = await import('../web/default-model-guard.js')
  const { logger } = await import('../logger.js')
  guard.resetDefaultModelGuardLog()
  return { guard, logger }
}

describe('model-less launch on the shipped default', () => {
  it('2.1.110 (the AVX-less pin) -> the previous tier, async and sync alike', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { guard } = await loadGuard(null)
    expect(await guard.launchableInstallDefault('agent:test')).toBe(DISTRIBUTION_DEFAULT_FALLBACK_MODEL)
    expect(guard.launchableInstallDefaultSync('worker')).toBe(DISTRIBUTION_DEFAULT_FALLBACK_MODEL)
    expect(guard.launchableDistributionDefaultSync('main')).toBe(DISTRIBUTION_DEFAULT_FALLBACK_MODEL)
  })

  it('2.1.280 -> the shipped default (positive control)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.280'
    const { guard } = await loadGuard(null)
    expect(await guard.launchableInstallDefault('agent:test')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(guard.launchableInstallDefaultSync('worker')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('unmeasured CLI -> the shipped default (fail-open)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = ''
    const { guard } = await loadGuard(null)
    expect(await guard.launchableInstallDefault('agent:test')).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('the fallback leaves ONE named warn line per surface and version, not one per call', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { guard, logger } = await loadGuard(null)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never)
    guard.launchableDistributionDefaultSync('main')
    guard.launchableDistributionDefaultSync('main')
    guard.launchableInstallDefaultSync('worker')
    const lines = warn.mock.calls.filter((c) => String(c[1] ?? '').includes('DEFAULTCLIGUARD927'))
    expect(lines).toHaveLength(2)
    expect(lines[0][0]).toMatchObject({ surface: 'main', installedCli: '2.1.110', launched: DISTRIBUTION_DEFAULT_FALLBACK_MODEL })
    warn.mockRestore()
  })
})

describe('an operator-configured DEFAULT_AGENT_MODEL is never replaced', () => {
  it('stays as configured even on 2.1.110', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { guard } = await loadGuard('claude-opus-5-5[1m]')
    expect(await guard.launchableInstallDefault('agent:test')).toBe('claude-opus-5-5[1m]')
    expect(guard.launchableInstallDefaultSync('worker')).toBe('claude-opus-5-5[1m]')
  })
})

// The launch sites themselves: each default path goes through the guard, and
// an explicit agent model does not. Source-level, like the RESPAWNMODEL807
// locks, because the launchers need tmux to run end to end.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
describe('every default launch path is wired to the guard', () => {
  it('sub-agent launch: only the resolution with source "default" is guarded', () => {
    const src = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')
    expect(src).toMatch(/resolvedModel\.source === 'default' \? await launchableInstallDefault\(/)
  })
  it('worker session: the non-custom-provider path is guarded', () => {
    const src = readFileSync(join(SRC, 'web', 'agent-worker.ts'), 'utf-8')
    // WORKERMODEL1773: the decision moved into resolveWorkerModel; the default
    // path still calls the guard (resolveWorkerModel's 'default' branch, tested
    // behaviourally in worker-model-cli-gate.test.ts).
    expect(src).toContain("launchableDefault: () => launchableInstallDefaultSync('worker')")
    expect(src).toContain('return { model: i.launchableDefault(), source: \'default\', unlaunchable: null }')
  })
  it('agent create without a model: guarded, not the raw default', () => {
    const src = readFileSync(join(SRC, 'web', 'routes', 'agents.ts'), 'utf-8')
    expect(src).toContain("rawModel || await launchableInstallDefault('agent-create', { fresh: true })")
    expect(src).not.toMatch(/rawModel \|\| DEFAULT_MODEL/)
  })
  it('main respawn: the distribution-default layer is guarded', () => {
    const src = readFileSync(join(SRC, 'web', 'channel-monitor.ts'), 'utf-8')
    expect(src).toContain("return launchableDistributionDefaultSync('main')")
  })
})
