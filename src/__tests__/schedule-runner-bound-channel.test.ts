// Behavioural guard for resolveBoundChannel, the function the provider-aware
// scheduled-task delivery hangs on. The source-contract tests in
// schedule-runner-bound-chatid.test.ts pin the call shape; this one pins what
// actually happens on disk: the access.json is read from the agent's OWN
// provider subdir (<agentDir>/.claude/channels/<provider>/access.json), and a
// missing binding yields {chatId: null} -- never a guess, never the other
// provider's file. Measured on the live CHANNEL_PROVIDER=slack install before
// the fix: telegram/access.json was read unconditionally, was absent, and every
// scheduled task shipped with no delivery instruction.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mock factories are hoisted but run lazily, on the dynamic import below,
// so they can safely read this module-level state.
const h = {
  tmpRoot: mkdtempSync(join(tmpdir(), 'bound-channel-')),
  provider: 'telegram' as 'telegram' | 'slack' | 'discord',
}

// Only agentDir is redirected: the sub-agent path must land in the tmp root.
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...real, agentDir: (name: string) => join(h.tmpRoot, 'agents', name) }
})

// Only resolveAgentProvider is redirected: it is the per-agent provider the
// test flips between cases.
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-process.js')>()
  return { ...real, resolveAgentProvider: () => h.provider }
})

const { resolveBoundChannel } = await import('../web/schedule-runner.js')

const AGENT = 'zara'

function writeAccess(provider: string, body: unknown): void {
  const dir = join(h.tmpRoot, 'agents', AGENT, '.claude', 'channels', provider)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'access.json'), JSON.stringify(body))
}

beforeEach(() => {
  rmSync(join(h.tmpRoot, 'agents'), { recursive: true, force: true })
  h.provider = 'telegram'
})
afterAll(() => rmSync(h.tmpRoot, { recursive: true, force: true }))

describe('resolveBoundChannel (sub-agent, on-disk access.json)', () => {
  it('a Slack-bound agent resolves from slack/access.json, not telegram/', () => {
    h.provider = 'slack'
    writeAccess('slack', { allowFrom: ['U0000000001'] })
    // A stale Telegram binding next to it must not win.
    writeAccess('telegram', { allowFrom: ['1268077055'] })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'slack', chatId: 'U0000000001' })
  })

  it('a Telegram-bound agent resolves from telegram/access.json (unchanged behaviour)', () => {
    writeAccess('telegram', { allowFrom: ['1268077055'] })
    writeAccess('slack', { allowFrom: ['U0000000001'] })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'telegram', chatId: '1268077055' })
  })

  it('a Slack agent bound only to a channel resolves the channel id', () => {
    h.provider = 'slack'
    writeAccess('slack', { allowFrom: [], channels: { C0000000001: {} } })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'slack', chatId: 'C0000000001' })
  })

  it('no access.json for the agent\'s provider -> chatId null, provider still reported', () => {
    h.provider = 'slack'
    // Only the OTHER provider's file exists: that is the pre-fix live shape
    // inverted, and it must not be borrowed.
    writeAccess('telegram', { allowFrom: ['1268077055'] })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'slack', chatId: null })
  })

  it('an empty or corrupt access.json is a config gap, not a default', () => {
    writeAccess('telegram', { allowFrom: [], groups: {} })
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'telegram', chatId: null })
    const dir = join(h.tmpRoot, 'agents', AGENT, '.claude', 'channels', 'telegram')
    writeFileSync(join(dir, 'access.json'), 'not json')
    expect(resolveBoundChannel(AGENT)).toEqual({ provider: 'telegram', chatId: null })
  })
})
