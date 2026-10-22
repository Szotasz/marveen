import { describe, it, expect } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import {
  APPROVAL_CALLBACK_RE, CALLBACK_DATA_MAX_BYTES, CALLBACK_NONCE_RE,
  buildCallbackData, parseCallbackData, newCallbackNonce, nonceHash, isCallbackNonce,
} from '../web/approval-callback-data.js'

// The button's callback_data is the only thing a press
// hands the plugin, and the nonce in it is the only part of the resulting PATCH
// a dashboard-token holder cannot read elsewhere. The parser must take exactly
// the shape the server builds and nothing near it.
const UUID = '3f2a9c0d-1e2b-4a4c-8d5e-6f708192a3b4'
const ID32 = '3f2a9c0d1e2b4a4c8d5e6f708192a3b4'
const NONCE = 'AbCdEfGhIjKlMnOpQr_-0w'

describe('newCallbackNonce', () => {
  it('is 16 random bytes as 22 base64url chars without padding', () => {
    const n = newCallbackNonce()
    expect(n).toHaveLength(22)
    expect(n).toMatch(CALLBACK_NONCE_RE)
    expect(n).not.toContain('=')
    expect(Buffer.from(n, 'base64url')).toHaveLength(16)
    expect(Buffer.from(n, 'base64url').toString('base64url')).toBe(n)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newCallbackNonce()))
    expect(seen.size).toBe(2000)
  })
})

describe('nonceHash', () => {
  it('is the sha256 hex of the nonce text, deterministic and not the nonce', () => {
    expect(nonceHash(NONCE)).toBe(createHash('sha256').update(NONCE, 'utf8').digest('hex'))
    expect(nonceHash(NONCE)).toMatch(/^[0-9a-f]{64}$/)
    expect(nonceHash(NONCE)).toBe(nonceHash(NONCE))
    expect(nonceHash(NONCE)).not.toBe(nonceHash(NONCE.slice(0, 21) + 'A'))
    expect(nonceHash(NONCE)).not.toContain(NONCE)
  })
})

describe('buildCallbackData', () => {
  it('builds the two buttons in the exact shape, 61 bytes each', () => {
    const a = buildCallbackData('approved', UUID, NONCE)
    const r = buildCallbackData('rejected', UUID, NONCE)
    expect(a).toBe(`apv:a:${ID32}:${NONCE}`)
    expect(r).toBe(`apv:r:${ID32}:${NONCE}`)
    for (const d of [a, r]) {
      expect(Buffer.byteLength(d, 'utf8')).toBe(61)
      expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES)
      expect(d).toMatch(APPROVAL_CALLBACK_RE)
    }
  })

  it('round-trips through the parser for real ids and nonces, always within 64 bytes', () => {
    for (let i = 0; i < 500; i++) {
      const id = randomUUID()
      const nonce = newCallbackNonce()
      for (const decision of ['approved', 'rejected'] as const) {
        const data = buildCallbackData(decision, id, nonce)
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
        expect(parseCallbackData(data)).toEqual({ decision, approvalId: id, nonce })
      }
    }
  })

  const badBuild: [string, unknown, unknown, unknown][] = [
    ['decision timeout', 'timeout', UUID, NONCE],
    ['decision pending', 'pending', UUID, NONCE],
    ['decision a', 'a', UUID, NONCE],
    ['uppercase uuid', 'approved', UUID.toUpperCase(), NONCE],
    ['uuid without dashes', 'approved', ID32, NONCE],
    ['uuid with braces', 'approved', `{${UUID}}`, NONCE],
    ['uuid not a string', 'approved', 5, NONCE],
    ['nonce 21 chars', 'approved', UUID, NONCE.slice(1)],
    ['nonce 23 chars', 'approved', UUID, NONCE + 'A'],
    ['nonce with padding', 'approved', UUID, NONCE.slice(2) + '=='],
    ['nonce with +', 'approved', UUID, NONCE.slice(1) + '+'],
    ['nonce with /', 'approved', UUID, NONCE.slice(1) + '/'],
    ['nonce with colon', 'approved', UUID, NONCE.slice(1) + ':'],
    ['nonce not a string', 'approved', UUID, null],
  ]
  it.each(badBuild)('throws on %s, without echoing the input', (_label, decision, id, nonce) => {
    let err: unknown
    try {
      buildCallbackData(decision as never, id as never, nonce as never)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TypeError)
    const msg = (err as Error).message
    if (typeof nonce === 'string') expect(msg).not.toContain(nonce)
    if (typeof id === 'string') expect(msg).not.toContain(id)
  })
})

describe('parseCallbackData', () => {
  const GOOD = `apv:a:${ID32}:${NONCE}`

  it('decodes approve and reject, restoring the UUID dashes', () => {
    expect(parseCallbackData(GOOD)).toEqual({ decision: 'approved', approvalId: UUID, nonce: NONCE })
    expect(parseCallbackData(`apv:r:${ID32}:${NONCE}`)).toEqual({ decision: 'rejected', approvalId: UUID, nonce: NONCE })
  })

  it('the shared regex is stateless (no g/y flag) and anchored', () => {
    expect(APPROVAL_CALLBACK_RE.flags).toBe('')
    expect(CALLBACK_NONCE_RE.flags).toBe('')
    // Repeated use must not alternate between match and miss (lastIndex).
    for (let i = 0; i < 3; i++) expect(APPROVAL_CALLBACK_RE.test(GOOD)).toBe(true)
  })

  const bad: [string, unknown][] = [
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['number', 61],
    ['object', { data: GOOD }],
    ['uppercase hex id', `apv:a:${ID32.toUpperCase()}:${NONCE}`],
    ['31-char id', `apv:a:${ID32.slice(1)}:${NONCE}`],
    ['33-char id', `apv:a:${ID32}0:${NONCE}`],
    ['dashed uuid', `apv:a:${UUID}:${NONCE}`],
    ['non-hex id', `apv:a:${ID32.slice(1)}g:${NONCE}`],
    ['21-char nonce', `apv:a:${ID32}:${NONCE.slice(1)}`],
    ['23-char nonce', `apv:a:${ID32}:${NONCE}A`],
    ['padded nonce', `apv:a:${ID32}:${NONCE}==`],
    ['padding inside the 22', `apv:a:${ID32}:${NONCE.slice(1)}=`],
    ['standard base64 +', `apv:a:${ID32}:${NONCE.slice(1)}+`],
    ['standard base64 /', `apv:a:${ID32}:${NONCE.slice(1)}/`],
    ['apv:x:', `apv:x:${ID32}:${NONCE}`],
    ['uppercase action', `apv:A:${ID32}:${NONCE}`],
    ['uppercase prefix', `APV:a:${ID32}:${NONCE}`],
    ['word action', `apv:approve:${ID32}:${NONCE}`],
    ['no nonce (D2 legacy shape)', `apv:a:${ID32}`],
    ['empty nonce', `apv:a:${ID32}:`],
    ['extra field', `${GOOD}:x`],
    ['trailing space', `${GOOD} `],
    ['leading space', ` ${GOOD}`],
    ['trailing newline', `${GOOD}\n`],
    ['trailing CRLF', `${GOOD}\r\n`],
    ['embedded newline', `apv:a:${ID32}\n:${NONCE}`],
    ['trailing NUL', `${GOOD}\u0000`],
    ['cyrillic a in prefix', `\u0430pv:a:${ID32}:${NONCE}`],
    ['cyrillic a as action', `apv:\u0430:${ID32}:${NONCE}`],
    ['fullwidth digit in id', `apv:a:\uff13${ID32.slice(1)}:${NONCE}`],
    ['fullwidth colon', `apv\uff1aa:${ID32}:${NONCE}`],
    ['perm allow', 'perm:allow:abcde'],
    ['perm deny', 'perm:deny:abcde'],
    ['perm-prefixed apv', `perm:${GOOD}`],
    ['two callbacks', `${GOOD}${GOOD}`],
  ]
  it.each(bad)('rejects: %s', (_label, data) => {
    expect(parseCallbackData(data)).toBeNull()
    if (typeof data === 'string') expect(APPROVAL_CALLBACK_RE.test(data)).toBe(false)
  })
})

describe('isCallbackNonce', () => {
  it('takes only the 22-char base64url form', () => {
    expect(isCallbackNonce(NONCE)).toBe(true)
    expect(isCallbackNonce(newCallbackNonce())).toBe(true)
    for (const v of [NONCE.slice(1), NONCE + 'A', NONCE.slice(1) + '=', `${NONCE}\n`, '', null, 22, undefined]) {
      expect(isCallbackNonce(v)).toBe(false)
    }
  })
})
