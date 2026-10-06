import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WRONGRECIP819, config surface. The resolver side of the explicit recipient
// pin is guarded by schedule-runner-bound-chatid.test.ts, but the line that
// carries `telegramChatId` from task-config.json onto the parsed task had no
// test of its own: deleting it makes the whole feature inert -- a pin written
// into task-config.json never reaches resolveTaskChannelTarget, which then
// falls back to the bound-channel resolution the pin exists to override --
// and the full suite stays green. Upstream measured exactly that on the
// rebased head (6221 assertions passing with the line removed), so this is a
// real gap, not a measurement artefact.
//
// os.homedir() reads $HOME on POSIX and SCHEDULED_TASKS_DIR is computed at
// import time, so HOME is pointed at a throwaway directory BEFORE the module
// is imported. The real exported functions are exercised, not a
// re-implementation of the parse.
const tmpHome = mkdtempSync(join(tmpdir(), 'task-chatid-home-'))
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

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('telegramChatId survives the task-config.json round trip', () => {
  it('arrives on the parsed task when the config pins a chat id', () => {
    writeTask('pinned-task', { schedule: '0 9 * * *', agent: 'sub', type: 'task', telegramChatId: '8918812779' })
    expect(io.readScheduledTask('pinned-task')?.telegramChatId).toBe('8918812779')
  })

  it('keeps the literal "none" opt-out instead of normalising it away', () => {
    // "none" means "this task has no direct Telegram recipient at all", which
    // is a different instruction from an unset field: the runner must be able
    // to tell them apart, so the parse may not collapse one into the other.
    writeTask('opted-out-task', { schedule: '0 9 * * *', telegramChatId: 'none' })
    expect(io.readScheduledTask('opted-out-task')?.telegramChatId).toBe('none')
  })

  it('is undefined when the field is absent, blank or not a string', () => {
    writeTask('unpinned-task', { schedule: '0 9 * * *' })
    expect(io.readScheduledTask('unpinned-task')?.telegramChatId).toBeUndefined()

    writeTask('blank-task', { schedule: '0 9 * * *', telegramChatId: '   ' })
    expect(io.readScheduledTask('blank-task')?.telegramChatId).toBeUndefined()

    writeTask('numeric-task', { schedule: '0 9 * * *', telegramChatId: 8918812779 })
    expect(io.readScheduledTask('numeric-task')?.telegramChatId).toBeUndefined()
  })

  it('trims surrounding whitespace so a hand-edited config still matches', () => {
    writeTask('padded-task', { schedule: '0 9 * * *', telegramChatId: ' 8918812779 ' })
    expect(io.readScheduledTask('padded-task')?.telegramChatId).toBe('8918812779')
  })

  it('writeScheduledTask persists the pin, and reading it back returns the same value', () => {
    io.writeScheduledTask('written-task', {
      description: 'fixture',
      prompt: 'run it',
      schedule: '0 9 * * *',
      agent: 'sub',
      type: 'task',
      telegramChatId: '8616857946',
    })
    const onDisk = JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, 'written-task', 'task-config.json'), 'utf8'))
    expect(onDisk.telegramChatId).toBe('8616857946')
    expect(io.readScheduledTask('written-task')?.telegramChatId).toBe('8616857946')
  })

  it('an update that omits the field leaves an existing pin in place', () => {
    // The PUT route passes telegramChatId through only when the caller sends
    // it; a partial update (e.g. toggling `enabled`) must not silently drop
    // the recipient and hand the task back to the guessing path.
    io.writeScheduledTask('kept-pin-task', { prompt: 'run it', schedule: '0 9 * * *', telegramChatId: '8918812779' })
    io.writeScheduledTask('kept-pin-task', { prompt: 'run it', schedule: '0 10 * * *' })
    expect(io.readScheduledTask('kept-pin-task')?.telegramChatId).toBe('8918812779')
  })
})
