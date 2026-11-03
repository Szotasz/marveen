import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// PRECHECKCWD1027, review follow-up. resolvePreCheckTimeoutMs was covered, but
// the clamp only ever sees what readScheduledTask put on the task. That parse is
// the setting's ONLY real input: if it stopped reading preCheckTimeoutSeconds
// from task-config.json, every other test would still pass and the feature would
// fall back to the 10 s default in production, silently. These cases pin the
// parse and the write against a real file on disk.
//
// os.homedir() reads $HOME on POSIX and SCHEDULED_TASKS_DIR is computed at
// import, so HOME is redirected BEFORE the module loads (same approach as
// scheduled-task-deletion-tombstone.test.ts) and the real exported functions
// are exercised, not a re-implementation.
const tmpHome = mkdtempSync(join(tmpdir(), 'precheck-timeout-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
process.env.MAIN_AGENT_ID = process.env.MAIN_AGENT_ID || 'marveen'

let io: typeof import('../web/scheduled-tasks-io.js')
let runner: typeof import('../web/schedule-runner.js')

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  runner = await import('../web/schedule-runner.js')
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

// Write a task by hand, the way an operator or an older install would: a real
// SKILL.md plus a task-config.json carrying exactly `config`.
function writeTaskOnDisk(name: string, config: Record<string, unknown>): void {
  const dir = join(io.SCHEDULED_TASKS_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\nDo something.\n`)
  writeFileSync(join(dir, 'task-config.json'), JSON.stringify(config, null, 2))
}

const BASE = { schedule: '*/5 * * * *', agent: 'angel', enabled: true, type: 'heartbeat' }

describe('readScheduledTask parses preCheckTimeoutSeconds from task-config.json', () => {
  it('keeps a number', () => {
    writeTaskOnDisk('t-number', { ...BASE, preCheck: 'pre-check.sh', preCheckTimeoutSeconds: 30 })
    expect(io.readScheduledTask('t-number')?.preCheckTimeoutSeconds).toBe(30)
  })

  it('leaves the field undefined when it is missing', () => {
    writeTaskOnDisk('t-missing', { ...BASE, preCheck: 'pre-check.sh' })
    expect(io.readScheduledTask('t-missing')?.preCheckTimeoutSeconds).toBeUndefined()
  })

  it('rejects a non-number from a hand-edited file', () => {
    // A string is the likeliest hand-edit ("30"), and JSON has no NaN literal,
    // so a hand-written NaN arrives as the bare token or as null.
    for (const [name, raw] of [['t-string', '30'], ['t-null', null], ['t-bool', true], ['t-obj', { seconds: 30 }]] as const) {
      writeTaskOnDisk(name, { ...BASE, preCheck: 'pre-check.sh', preCheckTimeoutSeconds: raw })
      expect(io.readScheduledTask(name)?.preCheckTimeoutSeconds, `${name}`).toBeUndefined()
    }
  })

  it('rejects a non-finite number', () => {
    // JSON.stringify writes Infinity/NaN as null, so reach the parse the way a
    // broken writer would: by putting the bare tokens in the file.
    const dir = join(io.SCHEDULED_TASKS_DIR, 't-nan')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: t-nan\ndescription: fixture\n---\nDo something.\n')
    writeFileSync(join(dir, 'task-config.json'), '{"schedule":"*/5 * * * *","agent":"angel","enabled":true,"type":"heartbeat","preCheckTimeoutSeconds":1e999}')
    expect(io.readScheduledTask('t-nan')?.preCheckTimeoutSeconds).toBeUndefined()
  })

  it('feeds the clamp: a parsed value reaches resolvePreCheckTimeoutMs', () => {
    // The end-to-end point of the setting -- file on disk to milliseconds.
    writeTaskOnDisk('t-wired', { ...BASE, preCheck: 'pre-check.sh', preCheckTimeoutSeconds: 30 })
    const task = io.readScheduledTask('t-wired')
    expect(task).not.toBeNull()
    expect(runner.resolvePreCheckTimeoutMs(task!)).toBe(30_000)

    writeTaskOnDisk('t-wired-default', { ...BASE, preCheck: 'pre-check.sh' })
    const plain = io.readScheduledTask('t-wired-default')
    expect(runner.resolvePreCheckTimeoutMs(plain!)).toBe(runner.PRECHECK_TIMEOUT_MS)
  })
})

describe('writeScheduledTask persists preCheckTimeoutSeconds', () => {
  it('round-trips the field through the file', () => {
    io.writeScheduledTask('t-written', {
      description: 'fixture', prompt: 'Do something.', schedule: '*/5 * * * *',
      agent: 'angel', enabled: true, type: 'heartbeat', preCheck: 'pre-check.sh',
      preCheckTimeoutSeconds: 45,
    })
    const onDisk = JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, 't-written', 'task-config.json'), 'utf-8'))
    expect(onDisk.preCheckTimeoutSeconds).toBe(45)
    expect(io.readScheduledTask('t-written')?.preCheckTimeoutSeconds).toBe(45)
  })

  it('writes no key when the caller does not set one', () => {
    // undefined must not become a literal null in the file: the next read would
    // take the same branch, but a null on disk reads as a deliberate choice.
    io.writeScheduledTask('t-unset', {
      description: 'fixture', prompt: 'Do something.', schedule: '*/5 * * * *',
      agent: 'angel', enabled: true, type: 'heartbeat', preCheck: 'pre-check.sh',
    })
    const onDisk = JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, 't-unset', 'task-config.json'), 'utf-8'))
    expect('preCheckTimeoutSeconds' in onDisk).toBe(false)
    expect(io.readScheduledTask('t-unset')?.preCheckTimeoutSeconds).toBeUndefined()
  })
})
