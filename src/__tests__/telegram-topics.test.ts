import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let effective = '0'
vi.mock('../settings-store.js', async (orig) => ({
  ...(await orig<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: () => effective,
}))

const {
  TOPIC_NAME_MAX,
  findTelegramTopic,
  normalizeTopicName,
  readTelegramTopics,
  removeTelegramTopic,
  saveTelegramTopic,
  telegramTopicsEnabled,
} = await import('../web/telegram-topics.js')

describe('telegramTopicsEnabled reads the switch like the plugin patcher', () => {
  it('"1" and a hand-written "true" are on, "0" is off', () => {
    effective = '1'
    expect(telegramTopicsEnabled()).toBe(true)
    effective = 'true'
    expect(telegramTopicsEnabled()).toBe(true)
    effective = '0'
    expect(telegramTopicsEnabled()).toBe(false)
  })
})

// store/telegram-topics.json: the named topics of the owner's main chat. A
// thread id is only valid in the chat it was opened in, so every lookup and
// write is keyed by that chat.

describe('telegram-topics store', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-topics-'))
    file = join(dir, 'telegram-topics.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a missing or unreadable file is "no topics", not an error', () => {
    expect(readTelegramTopics(file)).toBeNull()
    writeFileSync(file, 'not json')
    expect(readTelegramTopics(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ topics: { a: 1 } }))
    expect(readTelegramTopics(file)).toBeNull()
    expect(findTelegramTopic('a', '42', file)).toBeNull()
  })

  it('a saved topic is found by name, case-insensitively, with its stored spelling', () => {
    saveTelegramTopic('42', 'Napi hírek', 22200, file)
    expect(findTelegramTopic('napi HÍREK', '42', file)).toEqual({ name: 'Napi hírek', threadId: 22200 })
    expect(findTelegramTopic('  Napi   hírek ', '42', file)).toEqual({ name: 'Napi hírek', threadId: 22200 })
    expect(findTelegramTopic('Napi', '42', file)).toBeNull()
  })

  it('a topic of another chat is never returned', () => {
    saveTelegramTopic('42', 'Hírek', 7, file)
    expect(findTelegramTopic('Hírek', '43', file)).toBeNull()
  })

  it('a write for another chat drops the old chat\'s topics instead of mixing them', () => {
    saveTelegramTopic('42', 'Hírek', 7, file)
    saveTelegramTopic('43', 'Riport', 9, file)
    expect(readTelegramTopics(file)).toEqual({ chatId: '43', topics: { Riport: 9 } })
  })

  it('a write keeps the other topics of the same chat', () => {
    saveTelegramTopic('42', 'Hírek', 7, file)
    saveTelegramTopic('42', 'Riport', 9, file)
    expect(readTelegramTopics(file)).toEqual({ chatId: '42', topics: { Hírek: 7, Riport: 9 } })
  })

  it('the file is written owner-only', () => {
    saveTelegramTopic('42', 'Hírek', 7, file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ chatId: '42', topics: { Hírek: 7 } })
  })

  it('malformed entries of a hand-edited file are skipped, the rest is kept', () => {
    writeFileSync(file, JSON.stringify({ chatId: '42', topics: { Jó: 5, Rossz: 'x', Nulla: 0, Tört: 1.5, ' Szóköz': 3 } }))
    expect(readTelegramTopics(file)).toEqual({ chatId: '42', topics: { Jó: 5 } })
  })

  it('an invalid name or id is refused on write', () => {
    expect(() => saveTelegramTopic('42', '   ', 7, file)).toThrow(/invalid topic name/)
    expect(() => saveTelegramTopic('42', 'Hírek', 0, file)).toThrow(/invalid topic thread id/)
    expect(readTelegramTopics(file)).toBeNull()
  })

  it('remove drops only the named row (case-insensitively) and says what it removed', () => {
    saveTelegramTopic('42', 'Hírek', 7, file)
    saveTelegramTopic('42', 'Riport', 9, file)
    expect(removeTelegramTopic('42', 'hírek', file)).toEqual({ name: 'Hírek', threadId: 7 })
    expect(readTelegramTopics(file)).toEqual({ chatId: '42', topics: { Riport: 9 } })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('remove of an unknown name, another chat\'s topic or a missing file changes nothing', () => {
    expect(removeTelegramTopic('42', 'Hírek', file)).toBeNull()
    saveTelegramTopic('42', 'Hírek', 7, file)
    expect(removeTelegramTopic('42', 'Nincs', file)).toBeNull()
    expect(removeTelegramTopic('43', 'Hírek', file)).toBeNull()
    expect(readTelegramTopics(file)).toEqual({ chatId: '42', topics: { Hírek: 7 } })
  })

  it('normalizeTopicName collapses whitespace and enforces Telegram\'s length limit', () => {
    expect(normalizeTopicName('  a \n b  ')).toBe('a b')
    expect(normalizeTopicName('')).toBeNull()
    expect(normalizeTopicName('x'.repeat(TOPIC_NAME_MAX))).toBe('x'.repeat(TOPIC_NAME_MAX))
    expect(normalizeTopicName('x'.repeat(TOPIC_NAME_MAX + 1))).toBeNull()
  })
})
