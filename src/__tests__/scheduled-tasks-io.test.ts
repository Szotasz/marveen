import { describe, it, expect, vi } from 'vitest'

const { FAKE_HOME, TASK_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  const home = mkdtempSync(path.join(os.tmpdir(), 'sched-io-test-'))
  const tasksDir = path.join(home, '.claude', 'scheduled-tasks')
  const taskDir = path.join(tasksDir, 'test-task')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(path.join(taskDir, 'SKILL.md'), '---\nname: test-task\ndescription: A test task\n---\n\nDo something useful\n')
  writeFileSync(path.join(taskDir, 'task-config.json'), JSON.stringify({
    schedule: '0 9 * * *',
    agent: 'marveen',
    enabled: true,
    createdAt: 1700000000,
    type: 'task',
  }))
  return { FAKE_HOME: home, TASK_DIR: taskDir }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn().mockImplementation((path: string, content: string) => {
    require('node:fs').writeFileSync(path, content)
  }),
}))
// DB layer mock: countSchedules=0 forces file-based path (tests test the file IO)
vi.mock('../db.js', () => ({
  countSchedules:    vi.fn().mockReturnValue(0),
  getScheduleFromDb: vi.fn().mockReturnValue(undefined),
  upsertSchedule:    vi.fn(),
  listSchedulesFromDb: vi.fn().mockReturnValue([]),
  deleteSchedule:    vi.fn(),
  setScheduleEnabled: vi.fn(),
  patchSchedule:     vi.fn(),
}))

import {
  parseSkillMdFrontmatter,
  parseRequires,
  readScheduledTask,
  listScheduledTasks,
  writeScheduledTask,
} from '../web/scheduled-tasks-io.js'

describe('scheduled-tasks-io', () => {
  describe('parseSkillMdFrontmatter', () => {
    it('parses frontmatter and body correctly', () => {
      const content = '---\nname: my-task\ndescription: A task\n---\n\nDo something\n'
      const result = parseSkillMdFrontmatter(content)
      expect(result.name).toBe('my-task')
      expect(result.description).toBe('A task')
      expect(result.body).toContain('Do something')
    })

    it('returns body only when no frontmatter', () => {
      const content = 'No frontmatter here'
      const result = parseSkillMdFrontmatter(content)
      expect(result.name).toBeUndefined()
      expect(result.description).toBeUndefined()
      expect(result.body).toBe('No frontmatter here')
    })
  })

  describe('parseRequires', () => {
    it('returns undefined for undefined input', () => {
      expect(parseRequires(undefined)).toBeUndefined()
    })

    it('returns undefined when mcp_servers is not array', () => {
      expect(parseRequires({ mcp_servers: 'not-array' as any })).toBeUndefined()
    })

    it('returns parsed servers array', () => {
      const result = parseRequires({ mcp_servers: ['server-a', 'server-b'] })
      expect(result?.mcp_servers).toEqual(['server-a', 'server-b'])
    })

    it('returns undefined for empty servers array', () => {
      expect(parseRequires({ mcp_servers: [] })).toBeUndefined()
    })

    it('filters out non-string entries', () => {
      const result = parseRequires({ mcp_servers: ['ok', 42 as any, ''] })
      expect(result?.mcp_servers).toEqual(['ok'])
    })
  })

  describe('readScheduledTask', () => {
    it('reads existing task correctly', () => {
      const task = readScheduledTask('test-task')
      expect(task).not.toBeNull()
      expect(task!.name).toBe('test-task')
      expect(task!.description).toBe('A test task')
      expect(task!.schedule).toBe('0 9 * * *')
      expect(task!.agent).toBe('marveen')
      expect(task!.enabled).toBe(true)
      expect(task!.type).toBe('task')
    })

    it('returns null for nonexistent task', () => {
      expect(readScheduledTask('nonexistent-xyz')).toBeNull()
    })
  })

  describe('listScheduledTasks', () => {
    it('lists tasks from the scheduled-tasks directory', () => {
      const tasks = listScheduledTasks()
      expect(Array.isArray(tasks)).toBe(true)
      expect(tasks.some(t => t.name === 'test-task')).toBe(true)
    })
  })

  describe('writeScheduledTask', () => {
    it('creates a new task with provided data', () => {
      writeScheduledTask('new-test-task', {
        description: 'New task',
        prompt: 'Do new things',
        schedule: '0 8 * * 1',
        agent: 'marveen',
        enabled: true,
        type: 'heartbeat',
      })
      const task = readScheduledTask('new-test-task')
      expect(task).not.toBeNull()
      expect(task!.description).toBe('New task')
      expect(task!.schedule).toBe('0 8 * * 1')
      expect(task!.type).toBe('heartbeat')
    })
  })
})
