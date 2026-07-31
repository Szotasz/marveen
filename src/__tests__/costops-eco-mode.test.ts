import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  baseModelId,
  modelExpense,
  planEcoEnable,
  planEcoDisable,
  nextSavedOriginals,
  writeAgentModel,
  EMPTY_ECO_STATE,
  type AgentModel,
  type EcoModeState,
} from '../costops/eco-mode.js'

/**
 * F2 (kanban #132): one switch that moves the fleet to a cheap model.
 *
 * It writes configuration and never restarts anything -- a model change only
 * takes effect on the next restart, and that is an operator decision.
 */

const ECO = 'claude-sonnet-5' // $3/1M in
function fleet(...rows: Array<[string, string | null]>): AgentModel[] {
  return rows.map(([agent, model]) => ({ agent, model, path: `/fake/${agent}.json` }))
}

describe('model identity and expense', () => {
  it('strips the context-variant suffix', () => {
    // Agent configs carry `[1m]`; PRICE_MAP is keyed on the bare id the API
    // reports. Without this every suffixed agent would look unpriced.
    expect(baseModelId('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(baseModelId('claude-opus-5')).toBe('claude-opus-5')
  })

  it('prices a suffixed model the same as a bare one', () => {
    expect(modelExpense('claude-opus-5[1m]')).toBe(modelExpense('claude-opus-5'))
  })

  it('orders the models the fleet actually runs', () => {
    expect(modelExpense('claude-fable-5')).toBeGreaterThan(modelExpense('claude-opus-5')!)
    expect(modelExpense('claude-opus-5')).toBeGreaterThan(modelExpense('claude-sonnet-5')!)
    expect(modelExpense('claude-sonnet-5')).toBeGreaterThan(modelExpense('claude-haiku-4-5')!)
  })

  it('returns null for a model with no published rate', () => {
    expect(modelExpense('some-local-llm')).toBeNull()
    expect(modelExpense(null)).toBeNull()
  })
})

describe('switching eco mode on', () => {
  it('moves the expensive agents to the target', () => {
    const plan = planEcoEnable(fleet(['(main)', 'claude-fable-5'], ['prisma', 'claude-opus-5[1m]']), ECO)
    expect(plan.changes.map(c => c.agent).sort()).toEqual(['(main)', 'prisma'])
    expect(plan.changes.every(c => c.to === ECO)).toBe(true)
  })

  it('does NOT upgrade an agent that is already cheaper', () => {
    // The trap in "switch everything to X": an agent on haiku would be moved
    // UP to sonnet and cost more, which is the opposite of the point.
    const plan = planEcoEnable(fleet(['cheap', 'claude-haiku-4-5']), ECO)
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged[0].reason).toBe('already_cheaper_or_equal')
  })

  it('leaves an agent already at the target alone, suffix or not', () => {
    const plan = planEcoEnable(fleet(['a', 'claude-sonnet-5'], ['b', 'claude-sonnet-5[1m]']), ECO)
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged.map(u => u.reason)).toEqual(['already_at_target', 'already_at_target'])
  })

  it('leaves an unpriced model alone and says so', () => {
    // A change we cannot price is a change we cannot justify. Reported, not
    // silently skipped, so an unrecognised model shows up as a gap.
    const plan = planEcoEnable(fleet(['odd', 'some-local-llm']), ECO)
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged[0].reason).toBe('unpriced_model_left_alone')
  })

  it('treats a missing model field as eligible', () => {
    // No explicit field means the agent follows DEFAULT_MODEL, which we cannot
    // assume is cheap.
    const plan = planEcoEnable(fleet(['noconf', null]), ECO)
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({ from: null, to: ECO, reason: 'switched_to_eco' })
  })

  it('lists exactly the changed agents as needing a restart', () => {
    const plan = planEcoEnable(fleet(['(main)', 'claude-fable-5'], ['cheap', 'claude-haiku-4-5']), ECO)
    expect(plan.needsRestart).toEqual(['(main)'])
  })
})

describe('remembering the originals', () => {
  it('records what each changed agent was set to', () => {
    const current = fleet(['(main)', 'claude-fable-5'], ['prisma', 'claude-opus-5[1m]'])
    const plan = planEcoEnable(current, ECO)
    expect(nextSavedOriginals(plan, current, EMPTY_ECO_STATE)).toEqual({
      '(main)': 'claude-fable-5',
      prisma: 'claude-opus-5[1m]',
    })
  })

  it('records an absent model field as null, not as the default', () => {
    // null and absent are different states. Restoring an absent field by
    // writing today's DEFAULT_MODEL would pin the agent to whatever the
    // default happened to be, and stop it tracking future changes.
    const current = fleet(['noconf', null])
    const saved = nextSavedOriginals(planEcoEnable(current, ECO), current, EMPTY_ECO_STATE)
    expect(saved).toHaveProperty('noconf')
    expect(saved.noconf).toBeNull()
  })

  it('does not re-save when eco mode is already on', () => {
    // The one-way-door bug: running enable twice would otherwise overwrite the
    // originals with the eco model, and disable could never restore anything.
    const already: EcoModeState = {
      enabled: true, since: 1, target: ECO, saved: { '(main)': 'claude-fable-5' },
    }
    const current = fleet(['(main)', ECO]) // already switched
    expect(nextSavedOriginals(planEcoEnable(current, ECO), current, already)).toEqual({
      '(main)': 'claude-fable-5',
    })
  })
})

describe('switching eco mode off', () => {
  const state: EcoModeState = {
    enabled: true, since: 1, target: ECO,
    saved: { '(main)': 'claude-fable-5', noconf: null },
  }

  it('restores each agent to exactly what it was', () => {
    const plan = planEcoDisable(fleet(['(main)', ECO]), state)
    expect(plan.changes[0]).toMatchObject({ agent: '(main)', to: 'claude-fable-5', reason: 'restored' })
  })

  it('restores an originally-absent field by removing it, not by writing a model', () => {
    const plan = planEcoDisable(fleet(['noconf', ECO]), state)
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0].to).toBeNull()
  })

  it('leaves an agent it never touched alone', () => {
    const plan = planEcoDisable(fleet(['stranger', 'claude-opus-5']), state)
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged[0].reason).toBe('nothing_saved_to_restore')
  })

  it('round-trips: on then off returns the fleet to its exact starting point', () => {
    const start = fleet(['(main)', 'claude-fable-5'], ['prisma', 'claude-opus-5[1m]'], ['noconf', null], ['cheap', 'claude-haiku-4-5'])
    const onPlan = planEcoEnable(start, ECO)
    const saved = nextSavedOriginals(onPlan, start, EMPTY_ECO_STATE)

    const changed = new Map(onPlan.changes.map(c => [c.agent, c.to]))
    const after = start.map(a => ({ ...a, model: changed.has(a.agent) ? changed.get(a.agent)! : a.model }))

    const offPlan = planEcoDisable(after, { enabled: true, since: 1, target: ECO, saved })
    const restored = new Map(offPlan.changes.map(c => [c.agent, c.to]))
    const final = after.map(a => ({ agent: a.agent, model: restored.has(a.agent) ? restored.get(a.agent)! : a.model }))

    expect(final).toEqual(start.map(a => ({ agent: a.agent, model: a.model })))
  })
})

describe('writing a config file', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eco-'))
    path = join(dir, 'agent-config.json')
    writeFileSync(path, JSON.stringify({ model: 'claude-opus-5[1m]', voice: 'x', hooks: { a: 1 } }, null, 2))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('changes only the model and preserves everything else', () => {
    // These configs carry hooks, plugins and per-agent settings this module
    // knows nothing about; rewriting them from a typed shape would drop them.
    expect(writeAgentModel(path, ECO)).toBe(true)
    const cfg = JSON.parse(readFileSync(path, 'utf-8'))
    expect(cfg.model).toBe(ECO)
    expect(cfg.voice).toBe('x')
    expect(cfg.hooks).toEqual({ a: 1 })
  })

  it('removes the field entirely when given null', () => {
    expect(writeAgentModel(path, null)).toBe(true)
    const cfg = JSON.parse(readFileSync(path, 'utf-8'))
    expect(Object.hasOwn(cfg, 'model')).toBe(false)
    expect(cfg.voice).toBe('x')
  })

  it('leaves no temp file behind', () => {
    writeAgentModel(path, ECO)
    expect(() => readFileSync(`${path}.eco-tmp`, 'utf-8')).toThrow()
  })

  it('reports failure instead of throwing on a missing file', () => {
    expect(writeAgentModel(join(dir, 'nope.json'), ECO)).toBe(false)
  })
})
