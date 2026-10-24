// Scheduled-task registry x the server's own task writers (once-disable,
// rotation heartbeat). The REAL task files (sandbox HOME), the REAL registry
// (in-memory SQLite), no registry mock: the suites that cover once tasks and the
// rotation heartbeat mock the registry as a pass-through, which is exactly how
// the two gaps below stayed invisible.
//
//   * a once task the server switched off after its run stays registered, so a
//     later toggle/PUT is not refused 409 as "changed outside the dashboard API";
//   * a task that was NOT trusted before the server's rewrite is not laundered;
//   * the rotation heartbeat the server creates/toggles is registered, so the
//     runner (which fires registered tasks only) actually fires it.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { safeRmTmp } from './helpers/safe-rm-tmp.js'
import { join } from 'node:path'

// HOME must point at the sandbox BEFORE scheduled-tasks-io is imported:
// SCHEDULED_TASKS_DIR is computed from os.homedir() at import time.
const { tmpHome, realHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedsrc-rewrite-home-'))
  const prev = process.env.HOME
  process.env.HOME = dir
  return { tmpHome: dir, realHome: prev }
})

const settings = vi.hoisted(() => ({ CLAUDE_ROTATION_ENABLED: '1' } as Record<string, string>))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../settings-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (key: string) => settings[key] ?? '',
}))

import { initDatabase } from '../db.js'
import { SCHEDULED_TASKS_DIR, disableOnceTask, readScheduledTask, writeScheduledTask } from '../web/scheduled-tasks-io.js'
import { registerScheduledTask, verifyScheduledTask } from '../web/schedule-registry.js'
import { rewriteRegisteredTask } from '../web/schedule-registry-rewrite.js'
import {
  ROTATION_HEARTBEAT_TASK,
  ensureRotationHeartbeatTask,
  syncRotationHeartbeatTask,
} from '../web/claude-rotation-heartbeat.js'

function verdict(name: string) {
  const t = readScheduledTask(name)
  if (!t) throw new Error(`task ${name} missing`)
  return verifyScheduledTask(t)
}

function onceTask(name: string): void {
  writeScheduledTask(name, { prompt: 'egyszer', schedule: '0 5 * * *', agent: 'marveen', enabled: true, type: 'task', once: true })
}

beforeEach(() => {
  initDatabase(':memory:')
  safeRmTmp(SCHEDULED_TASKS_DIR)
  settings.CLAUDE_ROTATION_ENABLED = '1'
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('server rewrite of a registered task (disableOnceTask)', () => {
  it('control: the bare disableOnceTask leaves a stale hash (the defect this guards)', () => {
    onceTask('egyszeri-a')
    registerScheduledTask('egyszeri-a', 'api:create')
    expect(disableOnceTask('egyszeri-a', Date.now())).toBe(true)
    expect(verdict('egyszeri-a')).toMatchObject({ ok: false, reason: 'hash-mismatch' })
  })

  it('through rewriteRegisteredTask the switched-off task is still trusted', () => {
    onceTask('egyszeri-b')
    registerScheduledTask('egyszeri-b', 'api:create')
    expect(rewriteRegisteredTask('egyszeri-b', 'server:once-disable', () => disableOnceTask('egyszeri-b', Date.now()))).toBe(true)
    expect(readScheduledTask('egyszeri-b')?.enabled).toBe(false)
    expect(verdict('egyszeri-b')).toEqual({ ok: true })
  })

  it('a task that was untrusted before the rewrite stays untrusted (no laundering)', () => {
    onceTask('egyszeri-c')
    registerScheduledTask('egyszeri-c', 'api:create')
    // a hand edit after registration: the task is no longer trusted
    writeFileSync(join(SCHEDULED_TASKS_DIR, 'egyszeri-c', 'SKILL.md'), '---\nname: egyszeri-c\n---\n\nmas szoveg\n')
    expect(verdict('egyszeri-c').ok).toBe(false)
    expect(rewriteRegisteredTask('egyszeri-c', 'server:once-disable', () => disableOnceTask('egyszeri-c', Date.now()))).toBe(true)
    expect(verdict('egyszeri-c').ok).toBe(false)
  })

  it('a never-registered (planted) task is not registered by the rewrite', () => {
    onceTask('egyszeri-d')
    expect(rewriteRegisteredTask('egyszeri-d', 'server:once-disable', () => disableOnceTask('egyszeri-d', Date.now()))).toBe(true)
    expect(verdict('egyszeri-d')).toMatchObject({ ok: false, reason: 'unregistered' })
  })

  it('no change, no registration: the write result is passed through', () => {
    writeScheduledTask('nem-egyszeri', { prompt: 'x', schedule: '0 5 * * *', agent: 'marveen', enabled: true })
    registerScheduledTask('nem-egyszeri', 'api:create')
    expect(rewriteRegisteredTask('nem-egyszeri', 'server:once-disable', () => disableOnceTask('nem-egyszeri', Date.now()))).toBe(false)
    expect(verdict('nem-egyszeri')).toEqual({ ok: true })
  })
})

describe('rotation heartbeat is registered', () => {
  it('the startup ensure registers the task it creates', () => {
    expect(ensureRotationHeartbeatTask({ respectRemoval: true })).toBe('created')
    expect(verdict(ROTATION_HEARTBEAT_TASK)).toEqual({ ok: true })
  })

  it('the Settings toggle keeps it trusted in both directions', () => {
    expect(ensureRotationHeartbeatTask()).toBe('created')
    settings.CLAUDE_ROTATION_ENABLED = '0'
    expect(syncRotationHeartbeatTask()).toBe('disabled')
    expect(readScheduledTask(ROTATION_HEARTBEAT_TASK)?.enabled).toBe(false)
    expect(verdict(ROTATION_HEARTBEAT_TASK)).toEqual({ ok: true })
    settings.CLAUDE_ROTATION_ENABLED = '1'
    expect(syncRotationHeartbeatTask()).toBe('enabled')
    expect(readScheduledTask(ROTATION_HEARTBEAT_TASK)?.enabled).toBe(true)
    expect(verdict(ROTATION_HEARTBEAT_TASK)).toEqual({ ok: true })
  })

  it('an existing, unregistered task of that name is not laundered by the toggle', () => {
    writeScheduledTask(ROTATION_HEARTBEAT_TASK, { prompt: 'idegen', schedule: '* * * * *', agent: 'marveen', enabled: false })
    expect(syncRotationHeartbeatTask()).toBe('enabled')
    expect(verdict(ROTATION_HEARTBEAT_TASK)).toMatchObject({ ok: false, reason: 'unregistered' })
  })
})
