// WORKERMODELFAST1109: the fast worker session may run its own model
// (MARVEEN_WORKER_MODEL_FAST); unset, both sessions walk the same chain as before.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveWorkerModel, makeWorkerCtx, type WorkerModelInputs } from '../web/agent-worker.js'
import { SETTINGS_REGISTRY, AGENT_MODEL_CHOICES } from '../config-registry.js'

const OLD_CLI = '2.1.110'
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

describe('MARVEEN_WORKER_MODEL_FAST (WORKERMODELFAST1109)', () => {
  it('the fast override reports its own source and still goes through the CLI gate', () => {
    const d = resolveWorkerModel(inputs({ override: 'claude-opus-5-5[1m]', overrideSource: 'env:MARVEEN_WORKER_MODEL_FAST' }))
    expect(d.source).toBe('env:MARVEEN_WORKER_MODEL_FAST')
    expect(d.model).toBe('claude-opus-5[1m]')
    expect(d.unlaunchable?.requested).toBe('claude-opus-5-5[1m]')
  })

  it('without overrideSource an override keeps the old label (no behaviour change)', () => {
    expect(resolveWorkerModel(inputs({ override: 'claude-sonnet-5' })).source).toBe('env:MARVEEN_WORKER_MODEL')
    expect(resolveWorkerModel(inputs()).source).toBe('default')
  })

  it('a worker ctx carries the override only when one is given', () => {
    expect(makeWorkerCtx('s', '/tmp/h', 'claude-haiku-5-5').modelOverride).toBe('claude-haiku-5-5')
    expect(makeWorkerCtx('s', '/tmp/h').modelOverride).toBeNull()
  })

  it('the dashboard setting offers "" plus exactly the DEFAULT_AGENT_MODEL choices', () => {
    const fast = SETTINGS_REGISTRY.find((d) => d.key === 'MARVEEN_WORKER_MODEL_FAST')!
    const def = SETTINGS_REGISTRY.find((d) => d.key === 'DEFAULT_AGENT_MODEL')!
    expect(fast.default).toBe('')
    expect(fast.valueSet).toEqual(['', ...AGENT_MODEL_CHOICES])
    expect(def.valueSet).toEqual([...AGENT_MODEL_CHOICES])
  })

  it('only the FAST session gets the override; its own model drops the custom provider env', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-worker.ts'), 'utf-8')
    expect(src).toMatch(/const ctxFast = makeWorkerCtx\([\s\S]*?WORKER_MODEL_FAST_OVERRIDE,\s*\)/)
    expect(src).not.toMatch(/const ctxSlow = makeWorkerCtx\([^)]*WORKER_MODEL_FAST_OVERRIDE/)
    expect(src).toMatch(/if \(ctx\.modelOverride\) \{ customEnvPrefix = ''; customProviderModel = null \}/)
  })
})
