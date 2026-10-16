import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SLACKFOCSATORNA1007C, config surface: `channelProvider` must survive the
// task-config.json round trip, or the runner never sees it. Same setup as
// scheduled-task-telegram-chatid-config.test.ts: HOME points at a throwaway
// directory BEFORE the module computes SCHEDULED_TASKS_DIR.
const tmpHome = mkdtempSync(join(tmpdir(), 'task-provider-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')

const writeTask = (taskName: string, config: Record<string, unknown>) => {
  const dir = join(io.SCHEDULED_TASKS_DIR, taskName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${taskName}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(join(dir, 'task-config.json'), JSON.stringify(config, null, 2))
  return dir
}
const configOf = (taskName: string) => JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, taskName, 'task-config.json'), 'utf-8'))

beforeAll(async () => { io = await import('../web/scheduled-tasks-io.js') })
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }) })

describe('channelProvider in task-config.json', () => {
  it('arrives on the parsed task, next to the chat pin', () => {
    writeTask('slack-task', { schedule: '0 9 * * *', channelProvider: 'slack', telegramChatId: 'D0C74N9SAF6' })
    const t = io.readScheduledTask('slack-task')
    expect(t?.channelProvider).toBe('slack')
    expect(t?.telegramChatId).toBe('D0C74N9SAF6')
  })

  it('an unknown, mistyped or non-string value is ignored as if unset', () => {
    for (const v of ['whatsapp', 'Slack', '', 42, null]) {
      writeTask('bad-provider-task', { schedule: '0 9 * * *', channelProvider: v })
      expect(io.readScheduledTask('bad-provider-task')?.channelProvider, String(v)).toBeUndefined()
    }
    writeTask('no-provider-task', { schedule: '0 9 * * *' })
    expect(io.readScheduledTask('no-provider-task')?.channelProvider).toBeUndefined()
  })

  it('the writer stores a valid provider, clears it on null, and never writes an unknown one', () => {
    writeTask('writer-task', { schedule: '0 9 * * *', telegramChatId: '123' })
    io.writeScheduledTask('writer-task', { channelProvider: 'slack' })
    expect(configOf('writer-task').channelProvider).toBe('slack')
    expect(configOf('writer-task').telegramChatId).toBe('123')

    io.writeScheduledTask('writer-task', { channelProvider: 'nosuch' as never })
    expect(configOf('writer-task').channelProvider).toBe('slack')

    io.writeScheduledTask('writer-task', { channelProvider: null })
    expect('channelProvider' in configOf('writer-task')).toBe(false)

    io.writeScheduledTask('writer-task', { schedule: '0 10 * * *' })
    expect('channelProvider' in configOf('writer-task')).toBe(false)
  })
})
