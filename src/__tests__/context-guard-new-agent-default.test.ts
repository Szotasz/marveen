import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Fleet policy (2026-09-08): a newly created agent comes up with the context
// guard armed.
//
// The tempting implementation -- DEFAULT_CONTEXT_GUARD.enabled = true -- is
// wrong, because that constant is ALSO the answer for every agent with no
// store row, and two of those are deliberately proactive-tier-off: hidden
// technical workers (context-guard-hidden-worker.test.ts pins it) and existing
// agents whose operator never opted in. This suite pins the narrow fix:
// creation writes an EXPLICIT row, the global default stays off.
const SANDBOX = mkdtempSync(join(tmpdir(), 'cgseed-'))
mkdirSync(join(SANDBOX, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})

const STORE = join(SANDBOX, 'store', 'context-guard.json')
const {
  seedContextGuardForNewAgent,
  readContextGuardConfig,
  writeContextGuardConfig,
} = await import('../web/context-guard-store.js')
const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')

beforeEach(() => rmSync(STORE, { force: true }))
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('a newly created agent comes up with the context guard armed', () => {
  it('seeding writes an explicit enabled row', () => {
    const cfg = seedContextGuardForNewAgent('ujember')
    expect(cfg?.enabled).toBe(true)
    expect(cfg?.saturationRestart).toBe(true)
    expect(readContextGuardConfig('ujember').enabled).toBe(true)
    // Explicit ROW, not an inherited default: the persisted file has to name it.
    expect(JSON.parse(readFileSync(STORE, 'utf-8')).ujember.enabled).toBe(true)
  })

  it('the rest of the seeded row is the shipped default, not an invention', () => {
    const cfg = seedContextGuardForNewAgent('ujember')!
    expect(cfg).toEqual({ ...DEFAULT_CONTEXT_GUARD, enabled: true })
  })

  it('the GLOBAL default stays off -- an unseeded agent is unchanged', () => {
    // The regression this whole approach exists to avoid. Flipping the default
    // would arm agents/heartbeat and every never-configured agent silently.
    expect(DEFAULT_CONTEXT_GUARD.enabled).toBe(false)
    expect(DEFAULT_CONTEXT_GUARD.saturationRestart).toBe(true)
    const cfg = readContextGuardConfig('heartbeat')
    expect(cfg.enabled).toBe(false)
    expect(cfg.saturationRestart).toBe(true)
  })

  it('never overwrites an existing row -- a deliberate disable survives', () => {
    writeContextGuardConfig('regi', { ...DEFAULT_CONTEXT_GUARD, enabled: false })
    expect(seedContextGuardForNewAgent('regi')).toBeNull()
    expect(readContextGuardConfig('regi').enabled).toBe(false)
  })

  it('is idempotent: re-seeding an agent it already armed changes nothing', () => {
    const first = seedContextGuardForNewAgent('ujember')
    expect(seedContextGuardForNewAgent('ujember')).toBeNull()
    expect(readContextGuardConfig('ujember')).toEqual(first)
  })

  it('leaves other agents in the store untouched', () => {
    writeContextGuardConfig('masik', { ...DEFAULT_CONTEXT_GUARD, actPct: 0.5 })
    seedContextGuardForNewAgent('ujember')
    expect(readContextGuardConfig('masik').actPct).toBe(0.5)
    expect(readContextGuardConfig('ujember').enabled).toBe(true)
  })
})

describe('the creation path actually calls it', () => {
  const routeSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'agents.ts'),
    'utf8',
  )

  it('POST /api/agents seeds the guard BEFORE personality generation', () => {
    // Personality generation is the one step that can fail and fall back to a
    // template. Seeding after it would leave a usable-but-unguarded agent on
    // that path -- exactly the outcome the no-destructive-rollback fix was
    // careful to make survivable.
    const scaffold = routeSrc.indexOf('scaffoldAgentDir(name)')
    const seed = routeSrc.indexOf('seedContextGuardForNewAgent(name)')
    const generate = routeSrc.indexOf("'Generating agent CLAUDE.md and SOUL.md...'")
    expect(scaffold, 'scaffoldAgentDir call not found').toBeGreaterThan(-1)
    expect(seed, 'guard seed call not found').toBeGreaterThan(scaffold)
    expect(generate, 'personality generation log not found').toBeGreaterThan(seed)
  })

  it('the import paths seed it too -- an imported agent is new to this machine', () => {
    // The bundle carries the agent DIRECTORY; store/context-guard.json is not
    // in it, so without this an imported agent lands unguarded.
    expect(routeSrc).toMatch(/importAgentBundle\([\s\S]{0,200}?seedContextGuardForNewAgent\(result\.name\)/)
    expect(routeSrc).toMatch(/importAllAgentsBundle\([\s\S]{0,400}?seedContextGuardForNewAgent\(a\.name\)/)
  })
})
