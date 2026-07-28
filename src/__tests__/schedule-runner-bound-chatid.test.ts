import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatIdFromAccessConfig } from '../web/schedule-runner.js'

// Regression guard for 2026-07-27 (Zara report, Marveen diagnosis): the
// scheduled-task prompt prefix carried a "chat_id: 0" sentinel from a
// pre-plugin channel implementation. The official Telegram plugin rejects it
// (assertAllowedChat: "0" is never allowlisted), so every non-heartbeat
// scheduled task threw at delivery. The fix resolves the agent's own bound
// chat from its channel access.json at prompt-build time.

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

  it('multi-entry allowlists produce an ambiguity warn (heuristic made visible)', () => {
    // Behaviour stays first-entry; the warn exists so a reordered allowlist
    // (2+ entries: zara/iris) cannot silently redirect task results.
    expect(src).toContain('bound-chat resolution is ambiguous')
    expect(src).toMatch(/candidates > 1/)
  })

  it('resolution reads the same access.json the plugin enforces', () => {
    expect(src).toContain("channelStateDir('telegram'")
    expect(src).toContain('chatIdFromAccessConfig')
  })
})
