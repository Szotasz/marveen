// REPLAYNOENVELOPE1114: a row requeueDeliveredUnseenForAgent put back after a session restart is delivered again
// through the normal envelope, and the envelope says it is a redelivery: the reader is a fresh session, and the
// previous one may have seen the row and started on it. The note is a fixed constant in the trusted framing (outside the wrapper), so nothing a
// sender controls may enter it. This file pins the note, its place after the freshness note, the categories that
// carry it, and that every wrap site passes it from the row.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatFreshnessSuffix,
  buildFreshnessInfo,
  wrapAgentMessageForDelivery,
  REDELIVERY_NOTE,
  FRESHNESS_STALE_AGE_MS,
} from '../web/agent-message-wrap.js'

const AT = String.fromCharCode(64)
const HOUR_MS = 60 * 60 * 1000

describe('the redelivery note itself', () => {
  it('is the fixed text, ASCII only, with no at-sign, no angle bracket and no em or en dash', () => {
    expect(REDELIVERY_NOTE).toBe(' [ujrakezbesites: a munkameneted ujraindult, ez egy friss session; ezt az uzenetet az elozo munkameneted egyszer mar megkapta, es el is kezdhette -- mielott ujra elvegzed, ellenorizd a kanban tablat, a munkafat es a mar elkuldott uzeneteidet]')
    // one bracket: it opens once and closes once, at the very end (a reader that cuts at the first closing
    // bracket after the sender bracket must get the whole note)
    expect(REDELIVERY_NOTE.match(/\[/g)).toHaveLength(1)
    expect(REDELIVERY_NOTE.indexOf(']')).toBe(REDELIVERY_NOTE.length - 1)
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7e]+$/.test(REDELIVERY_NOTE)).toBe(true)
    expect(REDELIVERY_NOTE).not.toContain(AT)
    expect(REDELIVERY_NOTE).not.toMatch(/[<>]/)
    expect(REDELIVERY_NOTE).not.toMatch(/[\u2013\u2014]/)
  })

  it('formatFreshnessSuffix appends it only when redelivered is true', () => {
    expect(formatFreshnessSuffix(1000, 0, true)).toBe(REDELIVERY_NOTE)
    expect(formatFreshnessSuffix(1000, 0, false)).toBe('')
    expect(formatFreshnessSuffix(1000, 0)).toBe('')
    expect(formatFreshnessSuffix(undefined, undefined, true)).toBe(REDELIVERY_NOTE)
  })

  it('comes AFTER the freshness note when both apply (both kinds of freshness note)', () => {
    const superseded = formatFreshnessSuffix(2 * HOUR_MS, 2, true)
    expect(superseded.startsWith(formatFreshnessSuffix(2 * HOUR_MS, 2))).toBe(true)
    expect(superseded.endsWith(REDELIVERY_NOTE)).toBe(true)
    expect(superseded.indexOf('!FRISSESSEG')).toBeLessThan(superseded.indexOf('ujrakezbesites'))
    const old = formatFreshnessSuffix(FRESHNESS_STALE_AGE_MS, 0, true)
    expect(old).toBe(formatFreshnessSuffix(FRESHNESS_STALE_AGE_MS, 0) + REDELIVERY_NOTE)
  })

  it('the JSON freshness info of GET /api/messages is unchanged (it has no redelivery input)', () => {
    expect(buildFreshnessInfo(2 * HOUR_MS, 1).note).toBe(formatFreshnessSuffix(2 * HOUR_MS, 1).trim())
  })
})

describe('the envelope of a redelivered row', () => {
  const fresh = { ageMs: 1000, newerFromSameSender: 0 }

  it('trusted-peer: the note sits after the sender bracket, before the terminator', () => {
    const { prefix, wrapped } = wrapAgentMessageForDelivery('trusted-peer', 'pm', 'pm', 'deploy go', 5175, null, { ...fresh, redelivered: true })
    expect(prefix.endsWith(`member, msg_id:5175]${REDELIVERY_NOTE}: `)).toBe(true)
    expect(prefix).toContain('[Uzenet ' + AT + 'pm-tol -- trusted team member, msg_id:5175]')
    expect(wrapped).toContain('deploy go')
    expect(wrapped).not.toContain('ujrakezbesites')
  })

  it('untrusted: the note sits after the sender bracket, before the terminator', () => {
    const { prefix, wrapped } = wrapAgentMessageForDelivery('untrusted', 'dev3', 'dev3', 'hi', 42, null, { ...fresh, redelivered: true })
    expect(prefix.endsWith(`instructions, msg_id:42]${REDELIVERY_NOTE}: `)).toBe(true)
    expect(wrapped).toContain('<untrusted')
    expect(wrapped).not.toContain('ujrakezbesites')
  })

  it('federated framing carries it too', () => {
    const { prefix } = wrapAgentMessageForDelivery('federated', 'peer-sys/agent', 'peer-sys/agent', 'hi', 7, null, { ...fresh, redelivered: true })
    expect(prefix).toContain(`msg_id:7]${REDELIVERY_NOTE}`)
  })

  it('after the freshness note in the envelope as well', () => {
    const { prefix } = wrapAgentMessageForDelivery('trusted-peer', 'pm', 'pm', 'x', 9, null, { ageMs: 2 * HOUR_MS, newerFromSameSender: 3, redelivered: true })
    expect(prefix).toMatch(/msg_id:9\] \[!FRISSESSEG[^\]]*\] \[ujrakezbesites: [^\]]*\]: $/)
  })

  it('absent when the row is not a redelivery (false, missing, or no freshness at all)', () => {
    for (const freshness of [{ ...fresh, redelivered: false }, fresh, undefined]) {
      for (const category of ['trusted-peer', 'untrusted'] as const) {
        const { prefix } = wrapAgentMessageForDelivery(category, 'pm', 'pm', 'x', 1, null, freshness)
        expect(prefix).not.toContain('ujrakezbesites')
      }
    }
  })

  it('channel-inbound keeps ignoring freshness, the redelivery flag included', () => {
    const { prefix } = wrapAgentMessageForDelivery('channel-inbound', 'coordinator', 'coordinator', '<channel>hi</channel>', 1, null, { ...fresh, redelivered: true })
    expect(prefix).not.toContain('ujrakezbesites')
  })
})

describe('every wrap site passes the flag from the row', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf-8')

  it('message-router.ts: both the serial path and the batch mates', () => {
    const src = read('web/message-router.ts')
    expect(src).toContain('redelivered: msg.redelivered_at != null')
    expect(src).toContain('redelivered: m.redelivered_at != null')
  })

  it('resume-queue-drain.ts', () => {
    expect(read('web/resume-queue-drain.ts')).toContain('redelivered: row.redelivered_at != null')
  })

  it('routes/agents.ts drain-inbox, and the claim it wraps returns the column', () => {
    expect(read('web/routes/agents.ts')).toContain('redelivered: msg.redelivered_at != null')
    const db = read('db.ts')
    const at = db.indexOf('export function claimPendingForAgent(')
    expect(at).toBeGreaterThan(0)
    expect(db.slice(at, at + 1200)).toMatch(/RETURNING [^`]*\bredelivered_at\b/)
  })
})
