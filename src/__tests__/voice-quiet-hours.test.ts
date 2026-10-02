import { describe, expect, it } from 'vitest'
import {
  buildMorningVoiceNotice,
  flushHeldVoiceNotices,
  holdVoiceNotice,
  isVoiceQuietTime,
  msUntilVoiceQuietEnd,
  type HeldVoiceNotice,
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

  it('the time to the end of the window, also across the autumn clock change', () => {
    expect(msUntilVoiceQuietEnd(ms('2026-07-15T12:00:00Z'))).toBe(0) // day
    expect(msUntilVoiceQuietEnd(ms('2026-07-15T21:30:00Z'))).toBe(7.5 * 3_600_000) // 23:30 -> 07:00 CEST
    expect(msUntilVoiceQuietEnd(ms('2026-07-16T04:59:30Z'))).toBe(30_000) // 06:59:30 -> 07:00
    // 2026-10-25 03:00 CEST -> 02:00 CET: from 23:30 CEST (21:30Z) to 07:00 CET (06:00Z) is 8.5 hours
    expect(msUntilVoiceQuietEnd(ms('2026-10-24T21:30:00Z'))).toBe(8.5 * 3_600_000)
  })
})

describe('75c3d163 G2: a notice that arises in the window is held, and goes out ONCE per chat after 07:00', () => {
  const notice = (chatId: string, text: string, iso: string): HeldVoiceNotice => ({ chatId, text, heldAt: ms(iso) })

  it('NEGATIVE: a 23:30 notice is not sent while the window lasts', async () => {
    const store = new Map<string, HeldVoiceNotice[]>()
    const sent: Array<{ chatId: string; text: string }> = []
    const send = async (chatId: string, text: string) => { sent.push({ chatId, text }); return true }
    holdVoiceNotice(notice('111', 'A hangüzenetedet megkaptam, de nem sikerült leiratozni.', '2026-07-15T21:30:00Z'), store)
    expect(await flushHeldVoiceNotices(ms('2026-07-15T21:31:00Z'), send, store)).toBe(0) // 23:31
    expect(await flushHeldVoiceNotices(ms('2026-07-16T04:59:00Z'), send, store)).toBe(0) // 06:59
    expect(sent).toHaveLength(0)
    expect(store.get('111')).toHaveLength(1)
  })

  it('POSITIVE: after 07:00 every chat gets one combined message, in the order the notices arose', async () => {
    const store = new Map<string, HeldVoiceNotice[]>()
    const sent: Array<{ chatId: string; text: string }> = []
    const send = async (chatId: string, text: string) => { sent.push({ chatId, text }); return true }
    holdVoiceNotice(notice('111', 'ELSO', '2026-07-15T21:30:00Z'), store)
    holdVoiceNotice(notice('222', 'MASIK CHAT', '2026-07-15T22:10:00Z'), store)
    holdVoiceNotice(notice('111', 'MASODIK', '2026-07-16T02:00:00Z'), store)
    expect(await flushHeldVoiceNotices(ms('2026-07-16T05:00:30Z'), send, store)).toBe(2) // 07:00:30
    expect(sent.map((s) => s.chatId).sort()).toEqual(['111', '222'])
    const first = sent.find((s) => s.chatId === '111')!.text
    expect(first).toContain('(23:00-07:00)')
    expect(first.indexOf('ELSO')).toBeLessThan(first.indexOf('MASODIK'))
    expect(sent.find((s) => s.chatId === '222')!.text).toContain('MASIK CHAT')
    expect(store.size).toBe(0)
    // a second flush has nothing left to send
    expect(await flushHeldVoiceNotices(ms('2026-07-16T05:10:00Z'), send, store)).toBe(0)
    expect(sent).toHaveLength(2)
  })

  it('a failed morning send is counted as not sent, and the chat is not retried forever', async () => {
    const store = new Map<string, HeldVoiceNotice[]>()
    holdVoiceNotice(notice('111', 'ELSO', '2026-07-15T21:30:00Z'), store)
    expect(await flushHeldVoiceNotices(ms('2026-07-16T05:00:30Z'), async () => false, store)).toBe(0)
    expect(store.size).toBe(0)
  })

  it('the morning text: one notice on one line, several as a list under one head', () => {
    expect(buildMorningVoiceNotice([notice('1', 'EGY', '2026-07-15T21:30:00Z')]))
      .toBe('Az éjszakai csendes időszakban (23:00-07:00) küldött hangüzenetedről: EGY')
    expect(buildMorningVoiceNotice([notice('1', 'EGY', '2026-07-15T21:30:00Z'), notice('1', 'KETTO', '2026-07-15T22:30:00Z')]))
      .toBe('Az éjszakai csendes időszakban (23:00-07:00) küldött 2 hangüzenetedről:\n- EGY\n- KETTO')
  })
})
