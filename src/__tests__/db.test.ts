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
