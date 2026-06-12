import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  decodeIdTokenClaims, validateIdClaims, validateWorkspaceUser, buildGoogleAuthUrl,
  type GoogleIdClaims,
} from '../web/chat/google-oauth.js'
import { resolveAgentForEmail, resetChatUsersCache } from '../web/chat/chat-users.js'
import { parseCookies, buildSessionCookie, createSession, getChatUser, destroySession } from '../web/chat/chat-session.js'
import { initDatabase, createChatWebSession, getChatWebSession, pruneExpiredChatWebSessions } from '../db.js'
import type http from 'node:http'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'

function makeClaims(overrides: Partial<GoogleIdClaims> = {}): GoogleIdClaims {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: 'nonce-1',
    email: 'alice@example.com',
    email_verified: true,
    hd: 'example.com',
    ...overrides,
  }
}

describe('validateIdClaims', () => {
  const expected = { clientId: CLIENT_ID, nonce: 'nonce-1' }

  it('accepts a valid claim set', () => {
    expect(validateIdClaims(makeClaims(), expected)).toEqual({ ok: true })
  })

  it('rejects a foreign issuer', () => {
    const r = validateIdClaims(makeClaims({ iss: 'https://evil.example' }), expected)
    expect(r.ok).toBe(false)
  })

  it('rejects an audience mismatch (token minted for another client)', () => {
    const r = validateIdClaims(makeClaims({ aud: 'other-client' }), expected)
    expect(r.ok).toBe(false)
  })

  it('rejects an expired token', () => {
    const r = validateIdClaims(makeClaims({ exp: Math.floor(Date.now() / 1000) - 10 }), expected)
    expect(r.ok).toBe(false)
  })

  it('rejects a nonce mismatch (replayed token from another login flow)', () => {
    const r = validateIdClaims(makeClaims({ nonce: 'other-nonce' }), expected)
    expect(r.ok).toBe(false)
  })

  it('rejects an unverified email', () => {
    const r = validateIdClaims(makeClaims({ email_verified: false }), expected)
    expect(r.ok).toBe(false)
  })
})

describe('validateWorkspaceUser (server-side domain gate)', () => {
  it('accepts a workspace account of the allowed domain', () => {
    expect(validateWorkspaceUser(makeClaims(), 'example.com')).toEqual({ ok: true, email: 'alice@example.com' })
  })

  it('lowercases the returned email', () => {
    const r = validateWorkspaceUser(makeClaims({ email: 'Alice@Example.com' }), 'example.com')
    expect(r).toEqual({ ok: true, email: 'alice@example.com' })
  })

  it('rejects when hd is missing (consumer Gmail account)', () => {
    const r = validateWorkspaceUser(makeClaims({ hd: undefined }), 'example.com')
    expect(r.ok).toBe(false)
  })

  it('rejects a foreign workspace domain even with a matching email suffix', () => {
    const r = validateWorkspaceUser(makeClaims({ hd: 'other.com' }), 'example.com')
    expect(r.ok).toBe(false)
  })

  it('rejects an email outside the domain even when hd matches', () => {
    const r = validateWorkspaceUser(makeClaims({ email: 'alice@other.com' }), 'example.com')
    expect(r.ok).toBe(false)
  })

  it('rejects everything when no domain is configured', () => {
    const r = validateWorkspaceUser(makeClaims(), '')
    expect(r.ok).toBe(false)
  })
})

describe('decodeIdTokenClaims', () => {
  it('decodes the payload of an unsigned-format JWT', () => {
    const payload = Buffer.from(JSON.stringify(makeClaims()), 'utf-8').toString('base64url')
    const token = `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
    expect(decodeIdTokenClaims(token).email).toBe('alice@example.com')
  })

  it('throws on a malformed token', () => {
    expect(() => decodeIdTokenClaims('not-a-jwt')).toThrow()
  })
})

describe('buildGoogleAuthUrl', () => {
  it('carries state, nonce and the domain hint', () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: CLIENT_ID, redirectUri: 'https://chat.example.com/chat-api/auth/callback' }, 's1', 'n1', 'example.com'))
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('nonce')).toBe('n1')
    expect(url.searchParams.get('hd')).toBe('example.com')
    expect(url.searchParams.get('redirect_uri')).toBe('https://chat.example.com/chat-api/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid email')
  })
})

describe('chat-users mapping', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-users-'))
    path = join(dir, 'chat-users.json')
    resetChatUsersCache()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('resolves a mapped email case-insensitively', () => {
    writeFileSync(path, JSON.stringify({ 'Alice@Example.com': 'alice-agent' }))
    expect(resolveAgentForEmail('alice@EXAMPLE.com', path)).toBe('alice-agent')
  })

  it('returns null for an unmapped email (mapping doubles as allowlist)', () => {
    writeFileSync(path, JSON.stringify({ 'alice@example.com': 'alice-agent' }))
    expect(resolveAgentForEmail('mallory@example.com', path)).toBeNull()
  })

  it('returns null when the mapping file does not exist', () => {
    expect(resolveAgentForEmail('alice@example.com', join(dir, 'missing.json'))).toBeNull()
  })

  it('skips invalid entries instead of failing the whole file', () => {
    writeFileSync(path, JSON.stringify({ 'not-an-email': 'x', 'bob@example.com': 'bob-agent', 'carol@example.com': 42 }))
    expect(resolveAgentForEmail('bob@example.com', path)).toBe('bob-agent')
    expect(resolveAgentForEmail('carol@example.com', path)).toBeNull()
  })
})

describe('chat web sessions', () => {
  beforeEach(() => initDatabase(':memory:'))

  function fakeReq(cookie?: string): http.IncomingMessage {
    return { headers: cookie ? { cookie } : {} } as http.IncomingMessage
  }

  it('round-trips a session through the cookie', () => {
    const { sid } = createSession('alice@example.com', 'alice-agent')
    const user = getChatUser(fakeReq(`marveen_chat_sid=${sid}`))
    expect(user).toEqual({ email: 'alice@example.com', agentId: 'alice-agent' })
  })

  it('stores only a hash: the raw sid never appears in the DB', () => {
    const { sid } = createSession('alice@example.com', 'alice-agent')
    expect(getChatWebSession(sid)).toBeUndefined()
  })

  it('rejects a forged / malformed sid', () => {
    createSession('alice@example.com', 'alice-agent')
    expect(getChatUser(fakeReq('marveen_chat_sid=deadbeef'))).toBeNull()
    expect(getChatUser(fakeReq(`marveen_chat_sid=${'0'.repeat(64)}`))).toBeNull()
    expect(getChatUser(fakeReq())).toBeNull()
  })

  it('expires sessions and prunes them', () => {
    createChatWebSession('h1', 'a@example.com', 'a', -1000) // already expired
    expect(getChatWebSession('h1')).toBeUndefined()
    createChatWebSession('h2', 'b@example.com', 'b', -1000)
    expect(pruneExpiredChatWebSessions()).toBeGreaterThanOrEqual(1)
  })

  it('logout destroys the session server-side', () => {
    const { sid } = createSession('alice@example.com', 'alice-agent')
    destroySession(fakeReq(`marveen_chat_sid=${sid}`))
    expect(getChatUser(fakeReq(`marveen_chat_sid=${sid}`))).toBeNull()
  })

  it('session cookie is HttpOnly + SameSite=Lax', () => {
    const cookie = buildSessionCookie('abc', 60)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=60')
  })
})

describe('parseCookies', () => {
  it('parses multiple cookies and ignores malformed parts', () => {
    expect(parseCookies('a=1; b=2; malformed; c=%20x')).toEqual({ a: '1', b: '2', c: ' x' })
  })
  it('handles a missing header', () => {
    expect(parseCookies(undefined)).toEqual({})
  })
})
