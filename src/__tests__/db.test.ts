import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  getSession,
  setSession,
  clearSession,
  saveMemory,
  recentMemories,
  decayMemories,
  getMemoriesForChat,
  buildFtsMatchExpression,
} from '../db.js'

beforeAll(() => {
  // Teszt adatbázis inicializálás
  process.env.NODE_ENV = 'test'
  initDatabase()
})

describe('sessions', () => {
  it('munkamenetet ment es visszaolvas', () => {
    setSession('test-chat-1', 'session-abc')
    const s = getSession('test-chat-1')
    expect(s?.sessionId).toBe('session-abc')
    expect(s?.messageCount).toBe(0)
  })

  it('munkamenetet felulir', () => {
    setSession('test-chat-2', 'old-session')
    setSession('test-chat-2', 'new-session')
    expect(getSession('test-chat-2')?.sessionId).toBe('new-session')
  })

  it('munkamenetet torol', () => {
    setSession('test-chat-3', 'session-xyz')
    clearSession('test-chat-3')
    expect(getSession('test-chat-3')).toBeUndefined()
  })

  it('undefined ad vissza ha nem letezik', () => {
    expect(getSession('nem-letezik')).toBeUndefined()
  })
})

describe('memories', () => {
  it('emlek mentest es lekerdezest vegez', () => {
    saveMemory('mem-chat-1', 'Szeretem a kavét', 'semantic')
    const mems = recentMemories('mem-chat-1', 5)
    expect(mems.length).toBeGreaterThan(0)
    expect(mems[0].content).toBe('Szeretem a kavét')
    expect(mems[0].sector).toBe('semantic')
  })

  it('epizodikus emleket ment', () => {
    saveMemory('mem-chat-2', 'Mai megbeszeles eredmenye', 'episodic')
    const mems = getMemoriesForChat('mem-chat-2')
    expect(mems.length).toBeGreaterThan(0)
    expect(mems[0].sector).toBe('episodic')
  })

  it('leepulesi soprest vegrehajt hiba nelkul', () => {
    expect(() => decayMemories()).not.toThrow()
  })
})

describe('buildFtsMatchExpression', () => {
  it('produces prefix-matched tokens for a plain query', () => {
    expect(buildFtsMatchExpression('hello world')).toBe('hello* world*')
  })

  it('returns empty string for whitespace-only or empty input', () => {
    expect(buildFtsMatchExpression('')).toBe('')
    expect(buildFtsMatchExpression('   ')).toBe('')
    expect(buildFtsMatchExpression('!!!***???')).toBe('')
  })

  it('lowercases to neutralize FTS5 AND/OR/NOT/NEAR operators', () => {
    const out = buildFtsMatchExpression('foo OR bar AND baz NOT qux')
    // No uppercase operator keywords should survive as standalone tokens.
    expect(out).not.toMatch(/\bOR\b/)
    expect(out).not.toMatch(/\bAND\b/)
    expect(out).not.toMatch(/\bNOT\b/)
    expect(out).toBe('foo* or* bar* and* baz* not* qux*')
  })

  it('strips FTS5 punctuation (quotes, parens, colons); * is ours', () => {
    const out = buildFtsMatchExpression('"foo" (bar) baz qux:zap')
    expect(out).not.toMatch(/["():]/)
    // Every * in the output is our own prefix-match suffix, appended to a token.
    // No bare *, no doubled **.
    expect(out).not.toMatch(/\*\*/)
    expect(out).not.toMatch(/(^| )\*/)
    expect(out).toBe('foo* bar* baz* quxzap*')
  })

  it('caps at 20 tokens', () => {
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const out = buildFtsMatchExpression(many)
    expect(out.split(' ').length).toBe(20)
  })

  it('truncates individual tokens longer than 64 chars', () => {
    const long = 'a'.repeat(200)
    const out = buildFtsMatchExpression(long)
    // 64 'a's + '*'
    expect(out).toBe('a'.repeat(64) + '*')
  })

  it('preserves unicode letters and digits', () => {
    expect(buildFtsMatchExpression('Árvíztűrő 42')).toBe('árvíztűrő* 42*')
  })
})
