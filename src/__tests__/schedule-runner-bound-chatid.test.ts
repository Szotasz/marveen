import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatIdFromAccessConfig, resolveTaskTelegramTarget } from '../web/schedule-runner.js'

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
// by resolveTaskTelegramTarget: a sub-agent with 2+ candidates and no
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

  it('returns null for missing/empty/corrupt bindings (config gap, not a default)', () => {
    expect(chatIdFromAccessConfig(null)).toBeNull()
    expect(chatIdFromAccessConfig('nope')).toBeNull()
    expect(chatIdFromAccessConfig({})).toBeNull()
    expect(chatIdFromAccessConfig({ allowFrom: [], groups: {} })).toBeNull()
    expect(chatIdFromAccessConfig({ allowFrom: [''] })).toBeNull()
  })
})

describe('schedule-runner source contract (sentinel removed)', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')

  it('no prompt prefix carries the dead chat_id: 0 sentinel anymore', () => {
    expect(src).not.toMatch(/chat_id:\s*0[,)]/)
  })

  it('the no-binding branch omits the Telegram instruction instead of guessing a chat', () => {
    // The fallback prefix must be the bare task tag -- no Telegram mention, no
    // ALLOWED_CHAT_ID leak into a sub-agent prompt.
    expect(src).toContain('prompt omits the Telegram delivery instruction')
    expect(src).toMatch(/prefix = `\[Utemezett feladat: \$\{task\.name\}\] `/)
  })

  it('an ambiguous 2+-candidate resolution is SKIPPED, not guessed, and raises visibility', () => {
    // WRONGRECIP819: the old behaviour ("stays first-entry", just warns) is
    // gone. A sub-agent with 2+ DM contacts and no telegramChatId pin must
    // never receive a chat_id guess in its prompt.
    expect(src).toContain('scheduled task: telegram delivery target is ambiguous')
    expect(src).toContain('logger.error(')
    expect(src).toContain('createAgentMessage(')
    // The ambiguous branch falls through to the SAME bare-tag prefix as the
    // config-gap branch -- delivery is skipped either way, never guessed.
    const ambiguousIdx = src.indexOf('scheduled task: telegram delivery target is ambiguous')
    const nextPrefixIdx = src.indexOf('prefix = `[Utemezett feladat: ${task.name}] `', ambiguousIdx)
    expect(nextPrefixIdx, 'ambiguous branch must fall through to the bare prefix').toBeGreaterThan(ambiguousIdx)
  })

  it('resolution reads the same access.json the plugin enforces', () => {
    expect(src).toContain("channelStateDir('telegram'")
    expect(src).toContain('chatIdFromAccessConfig')
  })

  it('the main agent resolves via resolveOwnerChatId, not the allowlist-order heuristic', () => {
    // The main agent's bound channel genuinely IS the owner's (ALLOWED_CHAT_ID
    // first) by design -- see the fixed scheduled-task-chat-id-zero skill.
    // Only sub-agents go through the ambiguity gate.
    const fnStart = src.indexOf('export function resolveTaskTelegramTarget')
    expect(fnStart, 'resolveTaskTelegramTarget not found').toBeGreaterThan(0)
    const fnBody = src.slice(fnStart, src.indexOf('\n}\n', fnStart))
    expect(fnBody).toMatch(/agentName === MAIN_AGENT_ID\)\s*return\s*\{\s*chatId:\s*resolveOwnerChatId\(\)\s*\}/)
  })
})

describe('resolveTaskTelegramTarget (task.telegramChatId precedence, no filesystem needed)', () => {
  it('"none" means no Telegram target, by design -- never falls through to auto-resolution', () => {
    expect(resolveTaskTelegramTarget({ agent: 'sam', telegramChatId: 'none' })).toEqual({ chatId: null })
  })

  it('an explicit chat_id is used as-is, overriding any allowlist heuristic', () => {
    expect(resolveTaskTelegramTarget({ agent: 'max', telegramChatId: '8321555318' })).toEqual({ chatId: '8321555318' })
  })

  it('an explicit override wins even for the main agent (author intent beats the default)', () => {
    expect(resolveTaskTelegramTarget({ agent: 'pedro', telegramChatId: '8321555318' })).toEqual({ chatId: '8321555318' })
  })
})
