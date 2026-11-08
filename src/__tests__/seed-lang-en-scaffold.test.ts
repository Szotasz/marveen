import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// PERSONAESC1107 seed A: the dashboard's seeder (ensureDefaultScheduledTasks) reads i18n/en/scheduled-tasks/<task>/<file>
// on an English install, the repo's scheduled-tasks/<task>/<file> otherwise. HOME points at a temp dir BEFORE the
// modules load (the scheduled-tasks dir is computed at import), and the real function runs (the pattern of
// scheduled-task-deletion-tombstone.test.ts); the language is the function's parameter, so the checkout's own .env and
// CLAUDE.md do not decide the outcome.
const tmpHome = mkdtempSync(join(tmpdir(), 'seedlang-scaffold-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
process.env.MAIN_AGENT_ID = process.env.MAIN_AGENT_ID || 'marveen'

const ROOT = join(__dirname, '..', '..')
let scaffold: typeof import('../web/agent-scaffold.js')
let io: typeof import('../web/scheduled-tasks-io.js')

beforeAll(async () => {
  scaffold = await import('../web/agent-scaffold.js')
  io = await import('../web/scheduled-tasks-io.js')
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const clear = () => { if (existsSync(io.SCHEDULED_TASKS_DIR)) rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true }) }
const tasksWithEnglish = () => readdirSync(join(ROOT, 'i18n', 'en', 'scheduled-tasks'))

describe('ensureDefaultScheduledTasks(lang) (seed A)', () => {
  it('en: every top-level task with an English version is seeded from it', () => {
    clear()
    scaffold.ensureDefaultScheduledTasks('en')
    expect(tasksWithEnglish().length).toBeGreaterThanOrEqual(4)
    for (const task of tasksWithEnglish()) {
      const seeded = readFileSync(join(io.SCHEDULED_TASKS_DIR, task, 'SKILL.md'), 'utf-8')
      const en = readFileSync(join(ROOT, 'i18n', 'en', 'scheduled-tasks', task, 'SKILL.md'), 'utf-8')
      const hu = readFileSync(join(ROOT, 'scheduled-tasks', task, 'SKILL.md'), 'utf-8')
      // the placeholders are resolved; compare a line without any
      const plain = en.split('\n').find((l) => l.length > 30 && !l.includes('{{') && !hu.includes(l))
      expect(plain, `${task}: a line only the English version has`).toBeTruthy()
      expect(seeded).toContain(plain)
      expect(existsSync(join(io.SCHEDULED_TASKS_DIR, task, 'i18n'))).toBe(false)
    }
  })

  it('hu: the Hungarian sources, as before', () => {
    clear()
    scaffold.ensureDefaultScheduledTasks('hu')
    for (const task of tasksWithEnglish()) {
      const seeded = readFileSync(join(io.SCHEDULED_TASKS_DIR, task, 'SKILL.md'), 'utf-8')
      const en = readFileSync(join(ROOT, 'i18n', 'en', 'scheduled-tasks', task, 'SKILL.md'), 'utf-8')
      const hu = readFileSync(join(ROOT, 'scheduled-tasks', task, 'SKILL.md'), 'utf-8')
      const plain = hu.split('\n').find((l) => l.length > 30 && !l.includes('{{') && !en.includes(l))
      expect(plain, `${task}: a line only the Hungarian version has`).toBeTruthy()
      expect(seeded).toContain(plain)
    }
  })
})
