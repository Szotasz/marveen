import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createChatThread, getChatThread, listChatThreads, listOpenChatThreads,
  countOpenChatThreads, setChatThreadStatus, renameChatThread, touchChatThread,
  type ChatThread,
} from '../db.js'
import {
  threadSessionName, buildThreadLaunchCommand, pickIdleThreads,
} from '../web/chat/thread-process.js'

describe('chat_threads CRUD', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('creates a thread with a deterministic claude session id and lists it', () => {
    const t = createChatThread('alice', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'Első feladat')
    expect(t.status).toBe('open')
    expect(getChatThread(t.id)?.claude_session_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(listChatThreads('alice')).toHaveLength(1)
    expect(listChatThreads('bob')).toHaveLength(0)
  })

  it('closed threads drop out of the default list but stay queryable', () => {
    const t = createChatThread('alice', 's1')
    setChatThreadStatus(t.id, 'closed')
    expect(listChatThreads('alice')).toHaveLength(0)
    expect(listChatThreads('alice', { includeClosed: true })).toHaveLength(1)
  })

  it('counts only open threads (the per-agent cap input)', () => {
    const a = createChatThread('alice', 's1')
    createChatThread('alice', 's2')
    createChatThread('bob', 's3')
    setChatThreadStatus(a.id, 'suspended')
    expect(countOpenChatThreads('alice')).toBe(1)
    expect(countOpenChatThreads('bob')).toBe(1)
  })

  it('lists open threads across agents for the idle sweep', () => {
    createChatThread('alice', 's1')
    const b = createChatThread('bob', 's2')
    setChatThreadStatus(b.id, 'suspended')
    expect(listOpenChatThreads().map(t => t.agent_id)).toEqual(['alice'])
  })

  it('renames and touches a thread', () => {
    const t = createChatThread('alice', 's1')
    expect(renameChatThread(t.id, 'Új cím')).toBe(true)
    touchChatThread(t.id)
    const fresh = getChatThread(t.id)!
    expect(fresh.title).toBe('Új cím')
    expect(fresh.last_activity_at).toBeGreaterThanOrEqual(t.last_activity_at)
  })

  it('rejects an invalid status at the DB layer', () => {
    const t = createChatThread('alice', 's1')
    expect(() => setChatThreadStatus(t.id, 'bogus' as ChatThread['status'])).toThrow()
  })
})

describe('threadSessionName', () => {
  it('is namespaced under the agent and never collides with the main session', () => {
    const name = threadSessionName('alice', 'thread-1')
    expect(name).toBe('agent-alice-thread-thread-1')
    expect(name).not.toBe('agent-alice')
  })
})

describe('buildThreadLaunchCommand', () => {
  const base = {
    claudePath: '/usr/local/bin/claude',
    dir: '/home/m/agents/alice',
    model: 'claude-opus-4-8[1m]',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    skipPermissions: true,
    threadStateDir: '/home/m/agents/alice/.claude/chat-thread-state',
  }

  it('fresh thread pins the session id with --session-id', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: false })
    expect(cmd).toContain(`--session-id ${base.sessionId}`)
    expect(cmd).not.toContain('--resume')
    expect(cmd).not.toContain('--continue')
  })

  it('reopen uses --resume with the same id', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: true })
    expect(cmd).toContain(`--resume ${base.sessionId}`)
    expect(cmd).not.toContain('--session-id')
  })

  it('is always channel-less: no --channels, tokens unset, state dirs pointed at the inert thread dir', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: false })
    expect(cmd).not.toContain('--channels')
    expect(cmd).toContain('unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN')
    expect(cmd).toContain(`TELEGRAM_STATE_DIR="${base.threadStateDir}"`)
    expect(cmd).toContain(`SLACK_STATE_DIR="${base.threadStateDir}"`)
    expect(cmd).toContain(`DISCORD_STATE_DIR="${base.threadStateDir}"`)
  })

  it('single-quotes the model so [1m] suffixes do not glob-expand', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: false })
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'")
  })

  it('strict profile drops the dangerously-skip-permissions flag', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: false, skipPermissions: false })
    expect(cmd).not.toContain('--dangerously-skip-permissions')
  })

  it('api authMode injects the per-agent key; oauth mode does not', () => {
    const withKey = buildThreadLaunchCommand({ ...base, resume: false, apiKey: 'sk-ant-xxx' })
    expect(withKey).toContain('export ANTHROPIC_API_KEY="sk-ant-xxx"')
    const withoutKey = buildThreadLaunchCommand({ ...base, resume: false })
    expect(withoutKey).not.toContain('ANTHROPIC_API_KEY')
  })

  it('per-agent CLAUDE_CONFIG_DIR is exported when configured', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: false, claudeConfigDir: '/home/m/.claude-alt' })
    expect(cmd).toContain('export CLAUDE_CONFIG_DIR="/home/m/.claude-alt"')
  })

  it('ollama models get the local base url instead of an api key', () => {
    const cmd = buildThreadLaunchCommand({ ...base, resume: false, model: 'llama3', ollamaUrl: 'http://localhost:11434' })
    expect(cmd).toContain('ANTHROPIC_BASE_URL=http://localhost:11434')
    expect(cmd).toContain('ANTHROPIC_AUTH_TOKEN=ollama')
  })
})

describe('pickIdleThreads (idle backstop decision)', () => {
  const NOW = 1_000_000_000
  const IDLE = 45 * 60 * 1000

  function thread(overrides: Partial<ChatThread>): ChatThread {
    return {
      id: 't', agent_id: 'alice', title: '', status: 'open',
      claude_session_id: 's', created_at: 0, last_activity_at: NOW,
      ...overrides,
    }
  }

  it('suspends only open threads past the idle threshold', () => {
    const threads = [
      thread({ id: 'fresh', last_activity_at: NOW - IDLE + 1000 }),
      thread({ id: 'stale', last_activity_at: NOW - IDLE - 1000 }),
      thread({ id: 'already-suspended', status: 'suspended', last_activity_at: NOW - 10 * IDLE }),
      thread({ id: 'closed', status: 'closed', last_activity_at: NOW - 10 * IDLE }),
    ]
    expect(pickIdleThreads(threads, NOW, IDLE).map(t => t.id)).toEqual(['stale'])
  })

  it('boundary: exactly at the threshold counts as idle', () => {
    const t = thread({ id: 'edge', last_activity_at: NOW - IDLE })
    expect(pickIdleThreads([t], NOW, IDLE)).toHaveLength(1)
  })
})

describe('projectsDirFor encoding (transcript lookup)', () => {
  it('encodes every non-alphanumeric char as dash, matching Claude Code', async () => {
    const { projectsDirFor } = await import('../web/active-model.js')
    const dir = projectsDirFor('/Users/x/code/is_backend_system/agents/demo.v2', undefined, '/home/u')
    expect(dir).toBe('/home/u/.claude/projects/-Users-x-code-is-backend-system-agents-demo-v2')
  })
})
