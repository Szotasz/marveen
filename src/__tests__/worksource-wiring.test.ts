import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  enqueueWorksourceItemAt,
  worksourceItemExistsAt,
  worksourceItemId,
  worksourceRootFor,
} from '../web/worksource-queue.js'

let root: string

beforeEach(() => {
  root = join(tmpdir(), `worksource-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('worksourceItemId', () => {
  it('derives the id from the message row id, so the same message maps to the same item', () => {
    expect(worksourceItemId(42)).toBe(worksourceItemId(42))
    expect(worksourceItemId(42)).not.toBe(worksourceItemId(43))
  })

  it('produces an id the reader will accept rather than one it must sanitise', () => {
    // The reader refuses anything outside this shape instead of rewriting it:
    // a rewritten id would acknowledge the WRONG item.
    const READER_SHAPE = /^[A-Za-z0-9._-]{1,128}$/
    for (const raw of [1, 999999, '12', 'a/../b', 'x y']) {
      expect(worksourceItemId(raw)).toMatch(READER_SHAPE)
    }
  })

  it('strips path separators, so a hostile id cannot escape the queue directory', () => {
    expect(worksourceItemId('../../etc/passwd')).not.toContain('/')
  })
})

describe('enqueueWorksourceItemAt', () => {
  it('writes the item into pending/ where the reader looks for it', () => {
    expect(enqueueWorksourceItemAt(root, 'msg-1', 'do the thing')).toBe(true)
    const path = join(root, 'pending', 'msg-1.json')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).content).toBe('do the thing')
  })

  it('carries meta through, so the agent can see who sent it', () => {
    enqueueWorksourceItemAt(root, 'msg-2', 'x', { from: 'marveen-is', message_id: 2 })
    const item = JSON.parse(readFileSync(join(root, 'pending', 'msg-2.json'), 'utf8'))
    expect(item.meta.from).toBe('marveen-is')
    expect(item.meta.message_id).toBe(2)
  })

  it('creates the three queue directories the reader expects', () => {
    enqueueWorksourceItemAt(root, 'msg-3', 'x')
    for (const dir of ['pending', 'active', 'done']) {
      expect(existsSync(join(root, dir))).toBe(true)
    }
  })

  it('refuses a second enqueue of the same id: a retried tick must not double-deliver', () => {
    expect(enqueueWorksourceItemAt(root, 'msg-4', 'first')).toBe(true)
    expect(enqueueWorksourceItemAt(root, 'msg-4', 'second')).toBe(false)
    // And it must not have overwritten the queued content.
    expect(JSON.parse(readFileSync(join(root, 'pending', 'msg-4.json'), 'utf8')).content).toBe('first')
  })

  it('refuses to re-queue an item the agent is CURRENTLY working on (active/)', () => {
    mkdirSync(join(root, 'active'), { recursive: true })
    writeFileSync(join(root, 'active', 'msg-5.json'), '{}')
    expect(enqueueWorksourceItemAt(root, 'msg-5', 'x')).toBe(false)
    expect(existsSync(join(root, 'pending', 'msg-5.json'))).toBe(false)
  })

  it('refuses to re-queue an item the agent has already acknowledged (done/)', () => {
    mkdirSync(join(root, 'done'), { recursive: true })
    writeFileSync(join(root, 'done', 'msg-6.json'), '{}')
    expect(enqueueWorksourceItemAt(root, 'msg-6', 'x')).toBe(false)
    expect(existsSync(join(root, 'pending', 'msg-6.json'))).toBe(false)
  })

  it('leaves no partial file behind: the reader polls and would drop a half-written item', () => {
    enqueueWorksourceItemAt(root, 'msg-7', 'x'.repeat(200000))
    const parsed = JSON.parse(readFileSync(join(root, 'pending', 'msg-7.json'), 'utf8'))
    expect(parsed.content).toHaveLength(200000)
  })
})

describe('worksourceItemExistsAt', () => {
  it('is false for a root that does not exist yet', () => {
    expect(worksourceItemExistsAt(join(root, 'nope'), 'msg-1')).toBe(false)
  })
})

describe('worksourceRootFor', () => {
  it('is per-agent, so two agents never share a queue', () => {
    expect(worksourceRootFor('a')).not.toBe(worksourceRootFor('b'))
  })

  it('matches the layout the reader defaults to', () => {
    expect(worksourceRootFor('cortex-router').endsWith(join('.claude', 'channels', 'worksource', 'cortex-router'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Source contracts. These guard the two properties that make the wiring SAFE
// rather than merely working; both are invisible to a behavioural test because
// they are about what the code does NOT do.
// ---------------------------------------------------------------------------

describe('wiring contracts (source-level)', () => {
  const routerSrc = readFileSync(join(process.cwd(), 'src/web/message-router.ts'), 'utf8')
  const processSrc = readFileSync(join(process.cwd(), 'src/web/agent-process.ts'), 'utf8')

  it('the router skips the tmux-shaped gates for a worksource agent', () => {
    // "absent", "busy" and "stuck" are all statements about a keyboard. Applying
    // them to a queue invents a failure that does not exist -- and the stuck one
    // escalates with a restart suggestion.
    expect(routerSrc).toContain('!usesWorksource && shouldAbandon(')
    expect(routerSrc).toContain('!usesWorksource && !sessionExists')
    expect(routerSrc).toContain('!usesWorksource && !(await isSessionReadyForPrompt(')
  })

  it('the router still marks the message delivered through the DB helper', () => {
    // Not raw SQL: markMessageDelivered is what stamps delivered_at, and a
    // delivered row without a timestamp is pinned as a bug elsewhere.
    expect(routerSrc).toContain('markMessageDelivered(msg.id)')
  })

  it('the launcher does NOT gate worksource on hasChannel', () => {
    // hasChannel means "has a chat-provider bot token". It arms the plugin
    // watchdog, which would hunt for a bot poller a worksource agent never runs,
    // read it as "plugin down", and restart the agent on a loop.
    const line = processSrc.split('\n').find((l) => l.includes('readAgentWorksourceChannel(name)') && l.includes('if ('))
    expect(line, 'worksource launch gate not found').toBeTruthy()
    expect(line).not.toContain('hasChannel')
  })

  it('the dev-channels flag is scoped to opted-in agents, never fleet-wide', () => {
    const flagLines = processSrc.split('\n').filter((l) => l.includes('dangerously-load-development-channels'))
    expect(flagLines.length).toBeGreaterThan(0)
    // Every occurrence lives on the worksourceFlags assignment, which is only
    // reached inside the opt-in branch.
    for (const l of flagLines) {
      if (l.trim().startsWith('//')) continue
      expect(l).toContain('worksourceFlags =')
    }
  })

  it('the launcher merges into .mcp.json instead of overwriting a telegram entry', () => {
    // An agent may legitimately have both a chat channel and a work queue;
    // clobbering the file would silence the bot.
    expect(processSrc).toContain('mcpConfig.mcpServers.worksource =')
    expect(processSrc).toContain('existing.mcpServers')
  })
})
