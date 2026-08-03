// OWNERCHAT803 -- a one-way notification must reach the owner, and the
// installer placeholder must never reach the Bot API.
//
// Measured on a fresh wizard install (2026-08-03): pairing succeeds, the
// channel plugin works, inbound chat is fine -- and the main .env still says
// ALLOWED_CHAT_ID=0, because only the terminal install path writes the paired
// chat back. Every one-way send went to chat 0. Measured against the live Bot
// API: `sendMessage chat_id=0` answers 400 "chat not found".
//
// Why it survived so long: every guard in the codebase tested for EMPTINESS,
// and "0" is neither empty nor falsy, so the guards passed and the send went
// out to fail. These tests assert BOTH halves, because they are different
// claims: that a real id gets through, AND that the placeholder never does.
import { describe, expect, it } from 'vitest'
import { normalizeChatId, resolveOwnerChatId } from '../owner-chat.js'

const REAL = '1268077055'

/** Reader stub: serves one access.json body regardless of path. */
const reader = (body: unknown) => () => JSON.stringify(body)
/** Reader stub for an install with no channel configured. */
const noFile = () => {
  throw new Error('ENOENT')
}

describe('normalizeChatId', () => {
  it('treats the installer placeholder as NOT SET', () => {
    // The whole bug in one assertion. Before this, `!"0"` was false everywhere
    // and the placeholder sailed through into the API call.
    expect(normalizeChatId('0')).toBeNull()
    expect(normalizeChatId(' 0 ')).toBeNull()
    expect(normalizeChatId('')).toBeNull()
    expect(normalizeChatId('   ')).toBeNull()
    expect(normalizeChatId(null)).toBeNull()
    expect(normalizeChatId(undefined)).toBeNull()
  })

  it('keeps real chat ids, including negative group ids', () => {
    // Positive control: a normaliser that rejected everything would satisfy
    // every assertion above and silence the product completely.
    expect(normalizeChatId(REAL)).toBe(REAL)
    expect(normalizeChatId(`  ${REAL}  `)).toBe(REAL)
    // Telegram group ids are negative and start with -100...; "0" must not be
    // confused with "starts with a zero digit" or "numerically falsy".
    expect(normalizeChatId('-1001234567890')).toBe('-1001234567890')
    expect(normalizeChatId('01234')).toBe('01234')
  })
})

describe('resolveOwnerChatId', () => {
  it('prefers an explicitly configured chat id (pre-wizard installs are unchanged)', () => {
    expect(resolveOwnerChatId(reader({ allowFrom: ['999'] }), REAL)).toBe(REAL)
  })

  it('falls back to the paired channel when .env holds the placeholder', () => {
    // The reported case: wizard install, .env untouched at "0", access.json
    // populated by the pairing.
    expect(resolveOwnerChatId(reader({ allowFrom: [REAL] }), '0')).toBe(REAL)
    expect(resolveOwnerChatId(reader({ allowFrom: [REAL] }), '')).toBe(REAL)
  })

  it('accepts a numeric allowlist entry, and skips a placeholder inside it', () => {
    expect(resolveOwnerChatId(reader({ allowFrom: [Number(REAL)] }), '0')).toBe(REAL)
    // A "0" that got into access.json must not become the answer either --
    // the placeholder is refused wherever it appears, not just in .env.
    expect(resolveOwnerChatId(reader({ allowFrom: ['0', REAL] }), '0')).toBe(REAL)
  })

  it('falls back to an allowed group when there is no DM entry', () => {
    expect(resolveOwnerChatId(reader({ allowFrom: [], groups: { '-100999': {} } }), '0')).toBe('-100999')
  })

  it('returns null when this install genuinely has no owner chat', () => {
    // Null is a real answer, not a failure: callers must SKIP the send. The
    // alternative -- passing "0" on -- is what produced silent 400s.
    expect(resolveOwnerChatId(noFile, '0')).toBeNull()
    expect(resolveOwnerChatId(reader({ allowFrom: [] }), '0')).toBeNull()
    expect(resolveOwnerChatId(reader({ allowFrom: ['0'] }), '0')).toBeNull()
    expect(resolveOwnerChatId(() => 'not json', '0')).toBeNull()
  })

  it('NEVER returns the placeholder, whatever the inputs', () => {
    // The claim Marveen asked for explicitly, stated as its own test: it is a
    // different claim from "the real id gets through", and it is the one that
    // rules out the silent 400s.
    const inputs: Array<[unknown, string | null]> = [
      [{ allowFrom: ['0'] }, '0'],
      [{ allowFrom: [0] }, '0'],
      [{ allowFrom: [] }, '0'],
      [{ groups: { '0': {} } }, '0'],
      [{}, ' 0 '],
    ]
    for (const [body, env] of inputs) {
      const got = resolveOwnerChatId(reader(body), env)
      expect(got, `${JSON.stringify(body)} + env=${JSON.stringify(env)}`).not.toBe('0')
      expect(got).toBeNull()
    }
  })
})
