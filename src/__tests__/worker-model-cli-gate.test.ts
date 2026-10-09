/**
 * WORKERMODEL1773 (#1773): the worker's --model must meet the installed CLI's
 * model gate on EVERY path, not only on the shipped default.
 *
 * Measured before the fix (2026-10-07, the real guard, CLI version pinned to
 * 2.1.110, below the 2.1.280 minimum of claude-opus-5-5):
 *   - shipped default -> claude-opus-5[1m] (the #1609 guard falls back);
 *   - DEFAULT_AGENT_MODEL=claude-opus-5-5[1m] -> passed through unchanged;
 *   - MARVEEN_WORKER_MODEL=claude-opus-5-5[1m] -> never reached the guard.
 * Either way the worker session came up and every prompt got 400.
 *
 * resolveWorkerModel is the one place that decides the worker's model, and the
 * launch path (startWorkerSessionFor) goes through it; the pin at the bottom
 * keeps that binding.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWorkerModel, shouldNotifyWorkerModelFallback, workerModelFallbackText, workerModelFallbackKey, WORKER_MODEL_FALLBACK_NOTIFY_WINDOW_MS, type WorkerModelInputs } from '../web/agent-worker.js'

const OLD_CLI = '2.1.110'
const NEW_CLI = '2.1.290'
function inputs(over: Partial<WorkerModelInputs> = {}): WorkerModelInputs {
  return {
    override: null,
    customProviderModel: null,
    configuredDefault: 'claude-opus-5-5[1m]',
    defaultIsDistribution: true,
    launchableDefault: () => 'claude-opus-5[1m]',
    launchableFallback: () => 'claude-opus-5[1m]',
    installedCli: () => OLD_CLI,
    ...over,
  }
}

describe('resolveWorkerModel: the CLI gate sees the final model', () => {
  it('MARVEEN_WORKER_MODEL on an old CLI: this run falls back, flagged with the requested model and its source', () => {
    const d = resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]' }))
    expect(d.source).toBe('env:MARVEEN_WORKER_MODEL')
    expect(d.model).toBe('claude-opus-5[1m]')
    expect(d.unlaunchable).toEqual({ requested: 'claude-opus-5-5[1m]', minCli: '2.1.280', installedCli: OLD_CLI, fallback: 'claude-opus-5[1m]' })
  })

  it('an explicit DEFAULT_AGENT_MODEL on an old CLI: this run falls back, flagged with its source', () => {
    const d = resolveWorkerModel(inputs({ defaultIsDistribution: false }))
    expect(d.source).toBe('env:DEFAULT_AGENT_MODEL')
    expect(d.model).toBe('claude-opus-5[1m]')
    expect(d.unlaunchable).toEqual({ requested: 'claude-opus-5-5[1m]', minCli: '2.1.280', installedCli: OLD_CLI, fallback: 'claude-opus-5[1m]' })
  })

  it('the same explicit values on a CLI that meets the minimum are not flagged', () => {
    expect(resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', installedCli: () => NEW_CLI })).unlaunchable).toBeNull()
    expect(resolveWorkerModel(inputs({ defaultIsDistribution: false, installedCli: () => NEW_CLI })).unlaunchable).toBeNull()
  })

  it('an unmeasured CLI flags nothing (fail-open, like the picker gate)', () => {
    expect(resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', installedCli: () => null })).unlaunchable).toBeNull()
  })

  it('the shipped default still goes through the #1609 guard (unchanged behaviour)', () => {
    const guard = vi.fn(() => 'claude-opus-5[1m]')
    const d = resolveWorkerModel(inputs({ launchableDefault: guard }))
    expect(guard).toHaveBeenCalledTimes(1)
    expect(d).toEqual({ model: 'claude-opus-5[1m]', source: 'default', unlaunchable: null })
  })

  it('a custom-provider model is not a Claude model: not gated, the guard is not called', () => {
    const guard = vi.fn(() => 'x')
    const d = resolveWorkerModel(inputs({ customProviderModel: 'gpt-oss-120b', launchableDefault: guard }))
    expect(d).toEqual({ model: 'gpt-oss-120b', source: 'custom-provider', unlaunchable: null })
    expect(guard).not.toHaveBeenCalled()
  })

  it('MARVEEN_WORKER_MODEL wins over a custom provider (the existing priority)', () => {
    expect(resolveWorkerModel(inputs({ override: 'claude-opus-5', customProviderModel: 'gpt-oss-120b' })).source).toBe('env:MARVEEN_WORKER_MODEL')
  })
})

describe('WORKERMODEL1773 part 2: the owner decision (A)', () => {
  it('the fallback is asked only when the explicit model is unlaunchable', () => {
    const fb = vi.fn(() => 'claude-opus-5[1m]')
    resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', installedCli: () => NEW_CLI, launchableFallback: fb }))
    resolveWorkerModel(inputs({ launchableFallback: fb }))  // shipped default path
    expect(fb).not.toHaveBeenCalled()
    resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', launchableFallback: fb }))
    expect(fb).toHaveBeenCalledTimes(1)
  })

  it('a fallback the CLI cannot run either is not used: the requested model is kept and flagged with fallback null', () => {
    const d = resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', launchableFallback: () => 'claude-fable-5-1' }))
    expect(d.model).toBe('claude-opus-5-5[1m]')
    expect(d.unlaunchable).toEqual({ requested: 'claude-opus-5-5[1m]', minCli: '2.1.280', installedCli: OLD_CLI, fallback: null })
  })

  it('the setting is untouched: the inputs are only read, and the next run on a new CLI gets the configured model back', () => {
    const i = inputs({ override: 'claude-opus-5-5[1m]' })
    const before = JSON.stringify({ ...i, launchableDefault: 0, launchableFallback: 0, installedCli: 0 })
    expect(resolveWorkerModel(i).model).toBe('claude-opus-5[1m]')
    expect(JSON.stringify({ ...i, launchableDefault: 0, launchableFallback: 0, installedCli: 0 })).toBe(before)
    const later = resolveWorkerModel({ ...i, installedCli: () => NEW_CLI })
    expect(later).toEqual({ model: 'claude-opus-5-5[1m]', source: 'env:MARVEEN_WORKER_MODEL', unlaunchable: null })
  })

  it('the notice is rate-limited per configured model and CLI version, one per day', () => {
    const sent = new Map<string, number>()
    const T0 = 1_000_000
    expect(shouldNotifyWorkerModelFallback(sent, 'claude-opus-5-5[1m]|2.1.110', T0)).toBe(true)
    expect(shouldNotifyWorkerModelFallback(sent, 'claude-opus-5-5[1m]|2.1.110', T0 + 60_000)).toBe(false)
    expect(shouldNotifyWorkerModelFallback(sent, 'claude-opus-5-5[1m]|2.1.278', T0 + 60_000)).toBe(true)
    expect(shouldNotifyWorkerModelFallback(sent, 'claude-opus-5-5[1m]|2.1.110', T0 + WORKER_MODEL_FALLBACK_NOTIFY_WINDOW_MS - 1)).toBe(false)
    expect(shouldNotifyWorkerModelFallback(sent, 'claude-opus-5-5[1m]|2.1.110', T0 + WORKER_MODEL_FALLBACK_NOTIFY_WINDOW_MS)).toBe(true)
  })

  it('the rate-limit key carries the configured model and the CLI version (an upgrade or a new setting announces again)', () => {
    const k = (over: Partial<WorkerModelInputs>) => workerModelFallbackKey(resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', ...over })))
    expect(k({})).not.toBe(k({ installedCli: () => '2.1.278' }))
    expect(k({})).not.toBe(workerModelFallbackKey(resolveWorkerModel(inputs({ override: 'claude-fable-5-1' }))))
    expect(k({})).toBe(k({}))
  })

  it('the notice names the requested model, the source, the CLI, its minimum and the fallback, and says the setting was not changed', () => {
    const d = resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]' }))
    const t = workerModelFallbackText(d)
    for (const part of ['claude-opus-5-5[1m]', 'env:MARVEEN_WORKER_MODEL', '2.1.110', '2.1.280', 'claude-opus-5[1m]', 'nem írtuk át']) expect(t).toContain(part)
    expect(t).not.toMatch(/[\u2013\u2014]/)
    const none = workerModelFallbackText(resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', launchableFallback: () => 'claude-fable-5-1' })))
    expect(none).toContain('minden kérés hibát fog adni')
  })
})

describe('binding: the worker launch path uses the resolver and says so', () => {
  const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-worker.ts'), 'utf-8')
  const launch = SRC.slice(SRC.indexOf('function startWorkerSessionFor('), SRC.indexOf('export function workerContexts('))
  it('startWorkerSessionFor resolves --model through resolveWorkerModel, with the live CLI measurement', () => {
    expect(launch).toMatch(/const decision = resolveWorkerModel\(\{/)
    expect(launch).toMatch(/installedCli: \(\) => measureClaudeCliVersionSync\(\)\.version/)
    expect(launch).toMatch(/const workerModel = decision\.model/)
    expect(launch).toMatch(/--model \$\{shArg\(workerModel\)\}/)
  })
  it('an unlaunchable model is logged loudly, not silently launched', () => {
    expect(launch).toMatch(/if \(decision\.unlaunchable\) \{\s*logger\.warn\(/)
  })
  it('part 2: the fallback is the distribution guard, and the rate-limited notice fires in the unlaunchable branch', () => {
    expect(launch).toMatch(/launchableFallback: \(\) => launchableDistributionDefaultSync\('worker'\)/)
    const branch = launch.slice(launch.indexOf('if (decision.unlaunchable) {'), launch.indexOf('const claudeLaunchBin'))
    expect(branch).toMatch(/notifyWorkerModelFallback\(decision, Date\.now\(\)\)/)
  })
  it('part 2: the notice is keyed and worded by the tested pure functions, and goes to the operator channel', () => {
    const fn = SRC.slice(SRC.indexOf('function notifyWorkerModelFallback('), SRC.indexOf('export function resetWorkerModelFallbackNotices('))
    expect(fn).toMatch(/shouldNotifyWorkerModelFallback\(workerModelFallbackNotified, workerModelFallbackKey\(d\), nowMs\)/)
    expect(fn).toMatch(/notifyChannel\(workerModelFallbackText\(d\)\)/)
  })
  it('part 2: the launch path never writes the setting back', () => {
    expect(launch).not.toMatch(/writeFileSync|writeEnv|setSetting|config-overrides|\.env['"]/)
  })
})
