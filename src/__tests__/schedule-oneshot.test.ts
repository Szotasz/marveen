import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ONESHOT925: a oneShot task disables itself after its first scheduled fire.
const HOME = mkdtempSync(join(tmpdir(), 'oneshot-home-'))
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, homedir: () => HOME }
})

const io = await import('../web/scheduled-tasks-io.js')
const TASKS = join(HOME, '.claude', 'scheduled-tasks')

function seed(name: string, cfg: Record<string, unknown>): string {
  const dir = join(TASKS, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: t\n---\n\nprompt\n`)
  writeFileSync(join(dir, 'task-config.json'), JSON.stringify(cfg))
  return join(dir, 'task-config.json')
}
const read = (p: string) => JSON.parse(readFileSync(p, 'utf-8'))

describe('oneShot scheduled tasks', () => {
  beforeEach(() => { rmSync(TASKS, { recursive: true, force: true }) })
  afterAll(() => { rmSync(HOME, { recursive: true, force: true }) })

  it('reads oneShot only when it is literally true', () => {
    seed('a', { schedule: '0 10 28 9 *', oneShot: true })
    seed('b', { schedule: '0 10 28 9 *', oneShot: 'yes' })
    seed('c', { schedule: '0 10 28 9 *' })
    expect(io.readScheduledTask('a')?.oneShot).toBe(true)
    expect(io.readScheduledTask('b')?.oneShot).toBe(false)
    expect(io.readScheduledTask('c')?.oneShot).toBe(false)
  })

  it('disableOneShotTask sets enabled=false with a dated note, keeps other fields', () => {
    const p = seed('rem', { schedule: '0 10 28 9 *', agent: 'agent-a', oneShot: true, enabled: true })
    const at = Date.parse('2026-09-28T08:00:00Z')
    expect(io.disableOneShotTask('rem', at)).toBe(true)
    const cfg = read(p)
    expect(cfg.enabled).toBe(false)
    expect(cfg.oneShotDisabledAt).toBe('2026-09-28T08:00:00.000Z')
    expect(cfg.agent).toBe('agent-a')
    expect(cfg.schedule).toBe('0 10 28 9 *')
    expect(io.readScheduledTask('rem')?.enabled).toBe(false)
  })

  it('is idempotent and a no-op for missing tasks', () => {
    const p = seed('off', { schedule: '0 10 28 9 *', oneShot: true, enabled: false })
    expect(io.disableOneShotTask('off')).toBe(false)
    expect(read(p).oneShotDisabledAt).toBeUndefined()
    expect(io.disableOneShotTask('nope')).toBe(false)
  })

  it('writeScheduledTask persists oneShot', () => {
    io.writeScheduledTask('w', { prompt: 'x', schedule: '0 10 28 9 *', agent: 'agent-a', oneShot: true })
    expect(io.readScheduledTask('w')?.oneShot).toBe(true)
  })
})
