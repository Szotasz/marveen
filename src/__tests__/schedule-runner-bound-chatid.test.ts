import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { channelStateDir, type ChannelProviderType } from '../channel-provider.js'

// Behavioural fixture for the ambiguous-allowlist branch (see the
// "genuinely exercises the ambiguous branch" describe block below). Mocked
// BEFORE importing schedule-runner.js so the resolver's own
// `agentDir(agentName)` call resolves into a throwaway temp directory for
// this one fixture agent name, instead of the real repo's agents/ tree --
// every other agent name falls through to the real implementation
// unaffected.
let FIXTURE_DIR = ''
const FIXTURE_AGENT = 'ambiguous-fixture-agent-819'
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: (name: string) => (name === FIXTURE_AGENT ? FIXTURE_DIR : actual.agentDir(name)),
  }
})

const { chatIdFromAccessConfig, channelDeliveryName, resolveSchedulerAlertToken, resolveTaskChannelTarget } = await import('../web/schedule-runner.js')

// Regression guard for 2026-07-27 (Zara report, Marveen diagnosis): the
// scheduled-task prompt prefix carried a "chat_id: 0" sentinel from a
// pre-plugin channel implementation. The official Telegram plugin rejects it
// (assertAllowedChat: "0" is never allowlisted), so every non-heartbeat
// scheduled task threw at delivery. The fix resolves the agent's own bound
// chat from its channel access.json at prompt-build time.
//
// Second regression guard for 2026-08-19 (WRONGRECIP819, Marci, kanban
// f1217c23): the "resolve to the first allowlist entry" heuristic below
// silently misdirected sub-agent task results whenever an agent had 2+ DM
// contacts -- measured on the live install, 6 of 7 currently-enabled
// sub-agent `task`-type schedules were affected, either contradicting their
// own explicit recipient or carrying no real Telegram target at all. Fixed
// by resolveTaskChannelTarget: a sub-agent with 2+ candidates and no
// task.telegramChatId pin gets chatId: null + ambiguousCandidates set, never
// a guessed chat id.

describe('chatIdFromAccessConfig (pure core)', () => {
  it('returns the first DM allowlist entry', () => {
    expect(chatIdFromAccessConfig({ allowFrom: ['1268077055'], groups: {} })).toBe('1268077055')
    expect(chatIdFromAccessConfig({ allowFrom: ['111', '222'] })).toBe('111')
  })

  it('accepts numeric entries and trims strings', () => {
    expect(chatIdFromAccessConfig({ allowFrom: [1268077055] })).toBe('1268077055')
    expect(chatIdFromAccessConfig({ allowFrom: [' 42 '] })).toBe('42')
  })

  it('falls back to the first allowed group when no DM entry exists', () => {
    expect(chatIdFromAccessConfig({ allowFrom: [], groups: { '-100123': {} } })).toBe('-100123')
  })

  it('falls back to the Slack channels map when no DM entry exists', () => {
    // Slack access.json uses `channels`, not `groups` -- the same helper must
    // cover it so a Slack-bound agent with only a channel (no DM allowlist)
    // still resolves a deliverable id.
    expect(chatIdFromAccessConfig({ allowFrom: [], channels: { C0000000001: {} } })).toBe('C0000000001')
  })

  it('prefers the DM allowlist entry over a group/channel fallback', () => {
    expect(chatIdFromAccessConfig({ allowFrom: ['U0000000001'], channels: { C0123: {} } })).toBe('U0000000001')
  })

  it('returns null for missing/empty/corrupt bindings (config gap, not a default)', () => {
    expect(chatIdFromAccessConfig(null)).toBeNull()
    expect(chatIdFromAccessConfig('nope')).toBeNull()
    expect(chatIdFromAccessConfig({})).toBeNull()
    expect(chatIdFromAccessConfig({ allowFrom: [], groups: {} })).toBeNull()
    expect(chatIdFromAccessConfig({ allowFrom: [''] })).toBeNull()
  })
})

describe('channelDeliveryName (provider -> Hungarian channel noun)', () => {
  it('names each provider for the "kuldd el <ide>" instruction', () => {
    expect(channelDeliveryName('telegram')).toBe('Telegramon')
    expect(channelDeliveryName('slack')).toBe('Slacken')
    expect(channelDeliveryName('discord')).toBe('Discordon')
    expect(channelDeliveryName('googlechat')).toBe('Google Chaten')
    expect(channelDeliveryName('teams')).toBe('Teamsen')
  })
})

// Regression guard for the 2026-07-08 fix: the scheduler-alert bot token is
// looked up in marveen/.env FIRST and the main agent's channel .env SECOND, for
// every provider that has a bot token. The provider-aware rewrite once dropped
// the second location for Telegram and every alert went silent on hosts whose
// token lives in the plugin env. The reader is stubbed so the test pins the
// lookup ORDER and the empty-value fall-through, not the filesystem.
describe('resolveSchedulerAlertToken (lookup order via injected reader)', () => {
  const PROJECT_ENV = join(PROJECT_ROOT, '.env')
  const channelEnv = (p: ChannelProviderType) => join(channelStateDir(p), '.env')

  /** Reader stub: answers per path, records the calls in order. */
  function stub(answers: Record<string, string | null>) {
    const calls: Array<[ChannelProviderType, string]> = []
    const read = (p: ChannelProviderType, path: string) => {
      calls.push([p, path])
      return answers[path] ?? null
    }
    return { read, calls }
  }

  it('telegram: marveen/.env wins and the channel .env is not consulted', () => {
    const { read, calls } = stub({ [PROJECT_ENV]: '111:project', [channelEnv('telegram')]: '222:plugin' })
    expect(resolveSchedulerAlertToken('telegram', read)).toBe('111:project')
    expect(calls).toEqual([['telegram', PROJECT_ENV]])
  })

  it('telegram: falls back to ~/.claude/channels/telegram/.env (the plugin env)', () => {
    const { read, calls } = stub({ [PROJECT_ENV]: null, [channelEnv('telegram')]: '222:plugin' })
    expect(resolveSchedulerAlertToken('telegram', read)).toBe('222:plugin')
    expect(calls).toEqual([['telegram', PROJECT_ENV], ['telegram', channelEnv('telegram')]])
  })

  it('an EMPTY value in marveen/.env falls through, like the old `if (token)` did', () => {
    const { read } = stub({ [PROJECT_ENV]: '', [channelEnv('telegram')]: '222:plugin' })
    expect(resolveSchedulerAlertToken('telegram', read)).toBe('222:plugin')
  })

  it('slack: same two locations in the same order, provider passed through to the reader', () => {
    const { read, calls } = stub({ [PROJECT_ENV]: null, [channelEnv('slack')]: 'xoxb-channel' })
    expect(resolveSchedulerAlertToken('slack', read)).toBe('xoxb-channel')
    expect(calls).toEqual([['slack', PROJECT_ENV], ['slack', channelEnv('slack')]])
  })

  it('no token anywhere -> undefined (callers take the log-only branch)', () => {
    const { read } = stub({})
    expect(resolveSchedulerAlertToken('telegram', read)).toBeUndefined()
  })

  it('creds-based providers never read a token: their reader value is a project/app id, not a bot token', () => {
    const { read, calls } = stub({ [PROJECT_ENV]: 'project-id-would-be-here' })
    expect(resolveSchedulerAlertToken('googlechat', read)).toBeUndefined()
    expect(resolveSchedulerAlertToken('teams', read)).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe('schedule-runner source contract (sentinel removed, provider-aware)', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')

  it('no prompt prefix carries the dead chat_id: 0 sentinel anymore', () => {
    expect(src).not.toMatch(/chat_id:\s*0[,)]/)
  })

  it('the no-binding branch omits the delivery instruction instead of guessing a chat', () => {
    // The fallback prefix must be the bare task tag -- no channel mention, no
    // ALLOWED_CHAT_ID leak into a sub-agent prompt.
    expect(src).toContain('prompt omits the delivery instruction')
    expect(src).toMatch(/prefix = `\[Utemezett feladat: \$\{task\.name\}\] `/)
  })

  it('the delivery instruction names the resolved provider, not a hardcoded Telegram', () => {
    // Regression guard: the instruction used to say "Telegramon" for every
    // agent. It must now interpolate channelDeliveryName(bound.provider) so a
    // Slack-bound agent is told to reply on Slack.
    expect(src).toContain('channelDeliveryName(bound.provider)')
    expect(src).not.toMatch(/kuldd el Telegramon \(chat_id/)
  })

  it('an ambiguous 2+-candidate resolution is SKIPPED, not guessed, and raises visibility', () => {
    // WRONGRECIP819: the old behaviour ("stays first-entry", just warns) is
    // gone. An agent with 2+ DM contacts and no pinned chat id must never
    // receive a chat_id guess in its prompt.
    expect(src).toContain('scheduled task: delivery target is ambiguous')
    expect(src).toContain('logger.error(')
    expect(src).toContain('createAgentMessage(')
    // The ambiguous branch falls through to the SAME bare-tag prefix as the
    // config-gap branch -- delivery is skipped either way, never guessed.
    const ambiguousIdx = src.indexOf('scheduled task: delivery target is ambiguous')
    const nextPrefixIdx = src.indexOf('prefix = `[Utemezett feladat: ${task.name}] `', ambiguousIdx)
    expect(nextPrefixIdx, 'ambiguous branch must fall through to the bare prefix').toBeGreaterThan(ambiguousIdx)
  })

  it('resolution reads the access.json for the agent\'s own provider, not always telegram', () => {
    expect(src).toContain('resolveAgentProvider(agentName)')
    expect(src).toContain('channelStateDir(provider')
    expect(src).toContain('chatIdFromAccessConfig')
  })

  it('the system-level scheduler alerts send over CHANNEL_PROVIDER, not Telegram directly', () => {
    // The three alert paths (catch-up summary, pending-retry, task-timeout)
    // must route through the provider abstraction, never sendTelegramMessage.
    expect(src).not.toContain('sendTelegramMessage')
    expect(src).toContain('sendSchedulerAlertMessage')
    expect(src).toContain('getProvider(CHANNEL_PROVIDER)')
  })
})

describe('resolveTaskChannelTarget (pin precedence, no filesystem needed)', () => {
  it('"none" means no chat target, by design -- never falls through to auto-resolution', () => {
    expect(resolveTaskChannelTarget({ agent: 'sam', telegramChatId: 'none' }).chatId).toBeNull()
  })

  it('an explicit chat_id is used as-is, overriding any allowlist heuristic', () => {
    expect(resolveTaskChannelTarget({ agent: 'max', telegramChatId: '8321555318' }).chatId).toBe('8321555318')
  })

  it('an explicit override wins even for the main agent (author intent beats the default)', () => {
    expect(resolveTaskChannelTarget({ agent: 'pedro', telegramChatId: '8321555318' }).chatId).toBe('8321555318')
  })
})

// BEHAVIOURAL guard, not text-pinned: the source-contract tests above only
// prove certain STRINGS exist in schedule-runner.ts, which a mutation that
// reintroduces the "just use the first allowlist entry" guess would NOT
// touch (the log/notify strings stay in the file as dead code, unreached).
// This is the test that actually calls resolveTaskChannelTarget with a
// real 2-DM-contact access.json and asserts on the RETURNED VALUE -- the
// only way to catch a regression to the old heuristic. Verified red/green:
// reverting the sub-agent branch to `return { chatId: chatIdFromAccessConfig(raw) }`
// (dropping the `candidates > 1` check) makes this test fail
// ("expected ambiguousCandidates 2, got chatId '111111'"), while every other
// test in this file stays green. The assertions read the fields rather than
// deep-equalling the object, so adding a field to BoundChannel (e.g. the
// resolved provider) does not turn this guard red for the wrong reason.
describe('resolveTaskChannelTarget genuinely exercises the ambiguous branch (not text-pinned)', () => {
  beforeEach(() => {
    FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'ambiguous-chatid-'))
    mkdirSync(join(FIXTURE_DIR, '.claude', 'channels', 'telegram'), { recursive: true })
  })
  afterEach(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true })
    FIXTURE_DIR = ''
  })

  it('a sub-agent with 2 DM contacts and no telegramChatId pin gets null + ambiguousCandidates, never a guess', () => {
    writeFileSync(
      join(FIXTURE_DIR, '.claude', 'channels', 'telegram', 'access.json'),
      JSON.stringify({ allowFrom: ['111111', '222222'] }),
    )
    const target = resolveTaskChannelTarget({ agent: FIXTURE_AGENT })
    expect(target.chatId).toBeNull()
    expect(target.ambiguousCandidates).toBe(2)
  })

  it('a sub-agent with exactly ONE DM contact resolves it directly -- unambiguous, no guess involved', () => {
    writeFileSync(
      join(FIXTURE_DIR, '.claude', 'channels', 'telegram', 'access.json'),
      JSON.stringify({ allowFrom: ['111111'] }),
    )
    const target = resolveTaskChannelTarget({ agent: FIXTURE_AGENT })
    expect(target.chatId).toBe('111111')
    expect(target.ambiguousCandidates).toBeUndefined()
  })

  it('an explicit telegramChatId pin bypasses the ambiguity check entirely, even with 2+ contacts', () => {
    writeFileSync(
      join(FIXTURE_DIR, '.claude', 'channels', 'telegram', 'access.json'),
      JSON.stringify({ allowFrom: ['111111', '222222'] }),
    )
    expect(resolveTaskChannelTarget({ agent: FIXTURE_AGENT, telegramChatId: '333333' }).chatId).toBe('333333')
  })
})
