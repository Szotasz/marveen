import { describe, expect, it, vi } from 'vitest'
import { logger } from '../logger.js'
import {
  buildMorningVoiceNotice,
  isVoiceQuietTime,
  morningBatchVoiceKeywords,
  queueVoiceNoticeForMorningBatch,
  voiceNoticeHeldFor,
  voiceNoticeMorning,
  voiceQuietChats,
  type HeldVoiceNotice,
  type MorningBatchStore,
} from '../web/voice-quiet-hours.js'

// 75c3d163 G2: the voice channel notice keeps the owners' quiet period,
// 23:00-07:00 Budapest wall-clock time, in both summer (CEST, UTC+2) and winter (CET, UTC+1).
const ms = (iso: string) => Date.parse(iso)

describe('75c3d163 G2: the quiet window is 23:00-07:00 Budapest, whatever the host zone', () => {
  it('summer (CEST): 22:59 is not quiet, 23:00 and 23:30 are, 06:59 is, 07:00 is not', () => {
    expect(isVoiceQuietTime(ms('2026-07-15T20:59:00Z'))).toBe(false) // 22:59 Budapest
    expect(isVoiceQuietTime(ms('2026-07-15T21:00:00Z'))).toBe(true) // 23:00
    expect(isVoiceQuietTime(ms('2026-07-15T21:30:00Z'))).toBe(true) // 23:30
    expect(isVoiceQuietTime(ms('2026-07-16T04:59:59Z'))).toBe(true) // 06:59:59
    expect(isVoiceQuietTime(ms('2026-07-16T05:00:00Z'))).toBe(false) // 07:00
  })

  it('winter (CET): the same wall-clock edges sit one hour later in UTC', () => {
    expect(isVoiceQuietTime(ms('2026-01-15T21:59:00Z'))).toBe(false) // 22:59 Budapest
    expect(isVoiceQuietTime(ms('2026-01-15T22:00:00Z'))).toBe(true) // 23:00
    expect(isVoiceQuietTime(ms('2026-01-16T05:59:00Z'))).toBe(true) // 06:59
    expect(isVoiceQuietTime(ms('2026-01-16T06:00:00Z'))).toBe(false) // 07:00
  })

  it('NEGATIVE CONTROL: a UTC reading of the window would get 21:00Z-23:00Z (23:00-01:00 Budapest) wrong', () => {
    // 21:30Z is 23:30 in Budapest (summer): quiet. A window read in UTC (23-07) would call it day.
    expect(isVoiceQuietTime(ms('2026-07-15T21:30:00Z'))).toBe(true)
    // 05:30Z is 07:30 in Budapest (summer): day. A UTC window would still call it quiet.
    expect(isVoiceQuietTime(ms('2026-07-16T05:30:00Z'))).toBe(false)
  })
})

describe('75c3d163 (a): a listed chat\'s night notice goes into ONE morning batch row per chat and morning, nothing is sent', () => {
  const notice = (chatId: string, text: string, iso: string): HeldVoiceNotice => ({ chatId, text, heldAt: ms(iso) })
  // a store the size of the real one: rows by (agent, keywords), an id per row, every write recorded
  const fakeStore = () => {
    const rows: Array<{ id: number; agentId: string; keywords: string; content: string }> = []
    const writes: string[] = []
    const store: MorningBatchStore = {
      find: (agentId, keywords) => [...rows].reverse().find((r) => r.agentId === agentId && r.keywords === keywords),
      insert: (agentId, content, keywords) => { rows.push({ id: rows.length + 1, agentId, keywords, content }); writes.push('insert'); return rows.length },
      update: (id, content) => { rows.find((r) => r.id === id)!.content = content; writes.push(`update ${id}`) },
    }
    return { rows, writes, store }
  }

  it('the morning of a notice is the Budapest date of the coming morning: 23:xx counts to the next day', () => {
    expect(voiceNoticeMorning(ms('2026-07-15T21:30:00Z'))).toBe('2026-07-16') // 23:30 CEST
    expect(voiceNoticeMorning(ms('2026-07-15T22:10:00Z'))).toBe('2026-07-16') // 00:10 CEST
    expect(voiceNoticeMorning(ms('2026-07-16T04:59:00Z'))).toBe('2026-07-16') // 06:59 CEST
    expect(voiceNoticeMorning(ms('2026-01-15T22:30:00Z'))).toBe('2026-01-16') // 23:30 CET
    // the autumn clock change night (2026-10-25 03:00 CEST -> 02:00 CET)
    expect(voiceNoticeMorning(ms('2026-10-24T21:30:00Z'))).toBe('2026-10-25') // 23:30 CEST
    expect(voiceNoticeMorning(ms('2026-10-25T05:30:00Z'))).toBe('2026-10-25') // 06:30 CET
  })

  it('POSITIVE: the first notice inserts the row, a later one of the same night extends THE SAME row, in order', () => {
    const { rows, writes, store } = fakeStore()
    const a = queueVoiceNoticeForMorningBatch(notice('111', 'ELSO.', '2026-07-15T21:30:00Z'), store, 'fo-ugynok')
    const b = queueVoiceNoticeForMorningBatch(notice('111', 'MASODIK.', '2026-07-16T02:00:00Z'), store, 'fo-ugynok')
    expect(writes).toEqual(['insert', 'update 1'])
    expect(rows).toHaveLength(1)
    expect([a.rowId, a.count, b.rowId, b.count]).toEqual([1, 1, 1, 2])
    expect(rows[0].agentId).toBe('fo-ugynok')
    expect(rows[0].keywords).toBe(morningBatchVoiceKeywords('111', '2026-07-16'))
    expect(rows[0].keywords).toBe('reggeli-koteg-hang, chat:111, reggel:2026-07-16')
    const [head, ...items] = rows[0].content.split('\n')
    expect(head).toContain('chat 111, 2026-07-16 reggel, 2 jelzes')
    expect(head).toContain('EGY sorkent: "Az éjszakai csendes időszakban (23:00-07:00) küldött 2 hangüzenetedről: ELSO. MASODIK."')
    expect(items).toEqual(['- ELSO.', '- MASODIK.'])
  })

  it('another chat, or the next morning, gets its OWN row', () => {
    const { rows, store } = fakeStore()
    queueVoiceNoticeForMorningBatch(notice('111', 'EGY.', '2026-07-15T21:30:00Z'), store, 'fo')
    queueVoiceNoticeForMorningBatch(notice('222', 'MASIK CHAT.', '2026-07-15T22:00:00Z'), store, 'fo')
    queueVoiceNoticeForMorningBatch(notice('111', 'KOVETKEZO EJSZAKA.', '2026-07-16T21:30:00Z'), store, 'fo')
    expect(rows.map((r) => r.keywords)).toEqual([
      'reggeli-koteg-hang, chat:111, reggel:2026-07-16',
      'reggeli-koteg-hang, chat:222, reggel:2026-07-16',
      'reggeli-koteg-hang, chat:111, reggel:2026-07-17',
    ])
  })

  it('a notice text never breaks the row: a newline in it becomes a space', () => {
    const { rows, store } = fakeStore()
    queueVoiceNoticeForMorningBatch(notice('111', 'ELSO SOR\n- NEM TETEL', '2026-07-15T21:30:00Z'), store, 'fo')
    expect(rows[0].content.split('\n')).toHaveLength(2)
    expect(rows[0].content.split('\n')[1]).toBe('- ELSO SOR - NEM TETEL')
  })

  it('a failing store throws, so the caller can tell the agent that the notice reached nobody', () => {
    const store: MorningBatchStore = { find: () => undefined, insert: () => { throw new Error('memories unavailable') }, update: () => {} }
    expect(() => queueVoiceNoticeForMorningBatch(notice('111', 'EGY.', '2026-07-15T21:30:00Z'), store, 'fo')).toThrow('memories unavailable')
  })

  it('the line the batch carries: one notice as it is, several in order on ONE line', () => {
    expect(buildMorningVoiceNotice([notice('1', 'EGY.', '2026-07-15T21:30:00Z')]))
      .toBe('Az éjszakai csendes időszakban (23:00-07:00) küldött hangüzenetedről: EGY.')
    expect(buildMorningVoiceNotice([notice('1', 'EGY.', '2026-07-15T21:30:00Z'), notice('1', 'KETTO.', '2026-07-15T22:30:00Z')]))
      .toBe('Az éjszakai csendes időszakban (23:00-07:00) küldött 2 hangüzenetedről: EGY. KETTO.')
  })
})

describe('75c3d163 G2: the window holds only the recipients on the quiet list', () => {
  it('the list: numeric chat ids, comma-separated, anything else ignored, empty = nobody', () => {
    expect([...voiceQuietChats('')]).toEqual([])
    expect([...voiceQuietChats(' 111000111 , -100222 ')].sort()).toEqual(['-100222', '111000111'])
    expect([...voiceQuietChats('abc, 111000111')]).toEqual(['111000111'])
  })

  it('a listed recipient waits at 23:30 and not at 12:00; an unlisted one never waits', () => {
    const lista = new Set(['111000111'])
    expect(voiceNoticeHeldFor('111000111', ms('2026-07-15T21:30:00Z'), lista)).toBe(true) // 23:30 Budapest
    expect(voiceNoticeHeldFor('111000111', ms('2026-07-15T10:00:00Z'), lista)).toBe(false) // 12:00
    expect(voiceNoticeHeldFor('222000222', ms('2026-07-15T21:30:00Z'), lista)).toBe(false) // not on the list
    expect(voiceNoticeHeldFor('111000111', ms('2026-07-15T21:30:00Z'), new Set())).toBe(false) // empty list
  })
})

describe('bd849630 (2): a malformed VOICE_NOTICE_QUIET_CHATS is not silent', () => {
  it('a wrong separator holds nobody, and the count of the dropped elements goes to the log once, without the value', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      expect([...voiceQuietChats('333000333;444000444')]).toEqual([])
      expect([...voiceQuietChats('333000333;444000444')]).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toEqual({ invalid: 1, valid: 0 })
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/333000333|444000444/)
    } finally {
      warn.mockRestore()
    }
  })

  it('a mixed list keeps the valid ids and counts the bad element; a changed bad value is logged again', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      expect([...voiceQuietChats('555000555, x1, -600600')].sort()).toEqual(['-600600', '555000555'])
      expect(warn.mock.calls.map((c) => c[0])).toEqual([{ invalid: 1, valid: 2 }])
      expect([...voiceQuietChats('555000555 x 666000666')]).toEqual([])
      expect(warn.mock.calls.map((c) => c[0])).toEqual([{ invalid: 1, valid: 2 }, { invalid: 1, valid: 0 }])
    } finally {
      warn.mockRestore()
    }
  })

  it('a valid list, an empty one and stray commas log nothing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      expect([...voiceQuietChats('777000777, -800800')].sort()).toEqual(['-800800', '777000777'])
      expect([...voiceQuietChats('')]).toEqual([])
      expect([...voiceQuietChats(' , 777000777 ,, ')]).toEqual(['777000777'])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
