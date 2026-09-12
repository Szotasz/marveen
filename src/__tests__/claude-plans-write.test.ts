// PR2b write-path tests: writeClaudePlans() + the exported validatePlan().
// Uses a real temp directory as PROJECT_ROOT (mirrors autonomy-section.test.ts)
// so writes exercise the real atomic-write path without touching the repo's
// own store/ directory.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-write-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'agent-a', DEFAULT_AGENT_MODEL: 'claude-opus-5' }))

const { readClaudePlans, writeClaudePlans, validatePlan, CLAUDE_PLANS_PATH } =
  await import('../web/claude-plans.js')

const HOME = '/home/op'

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pro',
    label: 'Personal PRO',
    configDir: '/home/op/.claude-pro',
    planType: 'personal',
    channelsAllowed: true,
    ...over,
  }
}

describe('validatePlan (exported for the write API)', () => {
  it('accepts a well-formed plan', () => {
    const p = validatePlan(plan(), HOME)
    expect(p).toMatchObject({ id: 'pro', label: 'Personal PRO', planType: 'personal', channelsAllowed: true })
  })

  it('rejects the same malformed shapes resolveClaudePlans would drop', () => {
    expect(validatePlan(plan({ id: 'a b' }), HOME)).toBeNull()
    expect(validatePlan(plan({ planType: 'enterprise' }), HOME)).toBeNull()
    expect(validatePlan(plan({ channelsAllowed: 'yes' }), HOME)).toBeNull()
    expect(validatePlan(plan({ configDir: '~/../../etc' }), HOME)).toBeNull()
    expect(validatePlan('not an object', HOME)).toBeNull()
    expect(validatePlan(null, HOME)).toBeNull()
  })
})

describe('writeClaudePlans', () => {
  it('creates store/claude-plans.json (and the store dir) if absent', () => {
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
    const p = validatePlan(plan(), HOME)!
    writeClaudePlans([p])
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(true)
    const onDisk = JSON.parse(readFileSync(CLAUDE_PLANS_PATH, 'utf8'))
    expect(onDisk).toEqual([p])
  })

  it('round-trips through readClaudePlans immediately, no stale cache', () => {
    const first = validatePlan(plan({ id: 'a' }), HOME)!
    writeClaudePlans([first])
    expect(readClaudePlans().map((x) => x.id)).toEqual(['a'])

    // A second write right behind the first, within the same tick -- the
    // in-memory mtime cache must not serve the pre-write snapshot back.
    const second = validatePlan(plan({ id: 'b' }), HOME)!
    writeClaudePlans([first, second])
    expect(readClaudePlans().map((x) => x.id)).toEqual(['a', 'b'])

    writeClaudePlans([second])
    expect(readClaudePlans().map((x) => x.id)).toEqual(['b'])
  })
})
