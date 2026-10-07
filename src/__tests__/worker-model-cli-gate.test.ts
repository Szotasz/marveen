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
import { resolveWorkerModel, type WorkerModelInputs } from '../web/agent-worker.js'

const OLD_CLI = '2.1.110'
const NEW_CLI = '2.1.290'
function inputs(over: Partial<WorkerModelInputs> = {}): WorkerModelInputs {
  return {
    override: null,
    customProviderModel: null,
    configuredDefault: 'claude-opus-5-5[1m]',
    defaultIsDistribution: true,
    launchableDefault: () => 'claude-opus-5[1m]',
    installedCli: () => OLD_CLI,
    ...over,
  }
}

describe('resolveWorkerModel: the CLI gate sees the final model', () => {
  it('MARVEEN_WORKER_MODEL on an old CLI is flagged unlaunchable, with its source', () => {
    const d = resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]' }))
    expect(d.source).toBe('env:MARVEEN_WORKER_MODEL')
    expect(d.unlaunchable).toEqual({ minCli: '2.1.280', installedCli: OLD_CLI })
  })

  it('an explicit DEFAULT_AGENT_MODEL on an old CLI is flagged unlaunchable, with its source', () => {
    const d = resolveWorkerModel(inputs({ defaultIsDistribution: false }))
    expect(d.source).toBe('env:DEFAULT_AGENT_MODEL')
    expect(d.unlaunchable).toEqual({ minCli: '2.1.280', installedCli: OLD_CLI })
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
})
