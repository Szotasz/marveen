import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `telegramTopic` must survive the task-config.json round trip, or the runner
// never sees it. Same setup as scheduled-task-channel-provider-config.test.ts:
// HOME points at a throwaway directory BEFORE the module computes
// SCHEDULED_TASKS_DIR.
const tmpHome = mkdtempSync(join(tmpdir(), 'task-topic-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')

const writeTask = (taskName: string, config: Record<string, unknown>) => {
  const dir = join(io.SCHEDULED_TASKS_DIR, taskName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${taskName}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(join(dir, 'task-config.json'), JSON.stringify(config, null, 2))
}
const configOf = (taskName: string) => JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, taskName, 'task-config.json'), 'utf-8'))

beforeAll(async () => { io = await import('../web/scheduled-tasks-io.js') })
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }) })

describe('telegramTopic in task-config.json', () => {
  it('arrives on the parsed task, trimmed', () => {
    writeTask('topic-task', { schedule: '0 9 * * *', telegramTopic: '  Napi hírek ' })
    expect(io.readScheduledTask('topic-task')?.telegramTopic).toBe('Napi hírek')
  })

  it('an empty or non-string value is ignored as if unset', () => {
    for (const v of ['', '   ', 22200, null, ['x']]) {
      writeTask('bad-topic-task', { schedule: '0 9 * * *', telegramTopic: v })
      expect(io.readScheduledTask('bad-topic-task')?.telegramTopic, JSON.stringify(v)).toBeUndefined()
    }
    writeTask('no-topic-task', { schedule: '0 9 * * *' })
    expect(io.readScheduledTask('no-topic-task')?.telegramTopic).toBeUndefined()
  })

  it('a dashboard edit of the task keeps a hand-written telegramTopic', () => {
    writeTask('kept-topic-task', { schedule: '0 9 * * *', telegramTopic: 'Hírek' })
    io.writeScheduledTask('kept-topic-task', { schedule: '0 10 * * *' })
    expect(configOf('kept-topic-task').telegramTopic).toBe('Hírek')
  })
})
