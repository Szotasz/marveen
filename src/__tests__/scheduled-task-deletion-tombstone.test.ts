import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #796: a deleted DEFAULT scheduled task reappeared after an update, because
// seeding (ensureDefaultScheduledTasks on every dashboard start, and the shell
// seed loops) is skip-if-missing and nothing recorded the deletion. The fix is
// a tombstone (.removed-defaults) the DELETE route writes and all seed points
// read. os.homedir() reads $HOME on POSIX, so we point HOME at a temp dir
// BEFORE importing the modules (SCHEDULED_TASKS_DIR is computed at import) and
// exercise the real exported functions, not a re-implementation.
const tmpHome = mkdtempSync(join(tmpdir(), 'tombstone-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
process.env.MAIN_AGENT_ID = process.env.MAIN_AGENT_ID || 'marveen'

let io: typeof import('../web/scheduled-tasks-io.js')
let scaffold: typeof import('../web/agent-scaffold.js')
let dir: string

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  scaffold = await import('../web/agent-scaffold.js')
  dir = io.SCHEDULED_TASKS_DIR
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const taskDirs = () =>
  existsSync(dir)
    ? readdirSync(dir).filter(f => { try { return statSync(join(dir, f)).isDirectory() } catch { return false } })
    : []

describe('deleted default scheduled task stays deleted (#796)', () => {
  it('seeds the shipped defaults on first run', () => {
    scaffold.ensureDefaultScheduledTasks()
    const seeded = taskDirs()
    expect(seeded).toContain('memoria-heartbeat')
  })

  it('does not re-seed a default the operator deleted', () => {
    const victim = 'memoria-heartbeat'
    rmSync(join(dir, victim), { recursive: true, force: true })
    io.markDefaultTaskRemoved(victim)
    expect([...io.readRemovedDefaultTasks()]).toContain(victim)
    // a restart re-runs the seeder:
    scaffold.ensureDefaultScheduledTasks()
    expect(taskDirs()).not.toContain(victim)
  })

  it('keeps the tombstone as a plain file that listScheduledTasks ignores', () => {
    expect(statSync(join(dir, '.removed-defaults')).isFile()).toBe(true)
    expect(io.listScheduledTasks().some(t => t.name === '.removed-defaults')).toBe(false)
  })

  it('lifts the tombstone when the task is re-created, and it then survives re-seed', () => {
    const victim = 'memoria-heartbeat'
    io.writeScheduledTask(victim, { description: 'x', prompt: 'y', schedule: '0 0 * * *', agent: 'marveen' })
    expect(io.readRemovedDefaultTasks().size).toBe(0)
    scaffold.ensureDefaultScheduledTasks()
    expect(taskDirs()).toContain(victim)
  })
})
