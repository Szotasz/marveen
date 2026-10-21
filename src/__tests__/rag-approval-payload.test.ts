import { describe, it, expect } from 'vitest'
import {
  PERMISSION_BOT_CATEGORIES, parseRagApprovalPayload, validateRagApprovalRequest,
  canonicalRagPayload, ragPayloadContentHash, isReservedForeignCategory,
} from '../web/rag-approval-payload.js'

const PKG = 'ab'.repeat(32)
const RUN = '0123456789abcdef0123456789abcdef'
const NOW = 1792000000
const START = NOW - 60
const END = NOW + 3600

function text(over: Record<string, unknown> = {}, kind = 'rag_production_d'): string {
  const p = { kind, package_sha256: PKG, run_id: RUN, write_window_start: START, write_window_end: END, ...over }
  return JSON.stringify(p)
}
const good = text()

describe('constants', () => {
  it('lists exactly the two permission-bot categories', () => {
    expect([...PERMISSION_BOT_CATEGORIES]).toEqual(['rag_production_d', 'permission_bot_probe'])
  })
  it('only rag_production_d is allowed under the reserved prefix', () => {
    expect(isReservedForeignCategory('rag_production_d')).toBe(false)
    expect(isReservedForeignCategory('rag_production_e')).toBe(true)
    expect(isReservedForeignCategory('rag_production_')).toBe(true)
    expect(isReservedForeignCategory('permission_bot_probe')).toBe(false)
    expect(isReservedForeignCategory('email_send')).toBe(false)
  })
})

describe('parseRagApprovalPayload', () => {
  it('accepts the canonical text for both categories and round-trips it', () => {
    const a = parseRagApprovalPayload(good, 'rag_production_d')
    expect(a.ok).toBe(true)
    if (a.ok) expect(a.canonical).toBe(good)
    const probe = text({}, 'permission_bot_probe')
    expect(parseRagApprovalPayload(probe, 'permission_bot_probe').ok).toBe(true)
  })

  it('canonical text has the exact key order and no spaces', () => {
    expect(good).toBe(`{"kind":"rag_production_d","package_sha256":"${PKG}","run_id":"${RUN}","write_window_start":${START},"write_window_end":${END}}`)
    expect(canonicalRagPayload({ kind: 'rag_production_d', package_sha256: PKG, run_id: RUN, write_window_start: START, write_window_end: END })).toBe(good)
  })

  it('refuses a category that is not a permission-bot one', () => {
    expect(parseRagApprovalPayload(good, 'email_send')).toMatchObject({ ok: false, field: 'category' })
  })

  it('refuses a kind that differs from the category', () => {
    expect(parseRagApprovalPayload(good, 'permission_bot_probe')).toMatchObject({ ok: false, field: 'kind' })
    expect(parseRagApprovalPayload(text({}, 'permission_bot_probe'), 'rag_production_d')).toMatchObject({ ok: false, field: 'kind' })
  })

  it('refuses a wrong key order', () => {
    const swapped = `{"package_sha256":"${PKG}","kind":"rag_production_d","run_id":"${RUN}","write_window_start":${START},"write_window_end":${END}}`
    expect(parseRagApprovalPayload(swapped, 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
    const endFirst = `{"kind":"rag_production_d","package_sha256":"${PKG}","run_id":"${RUN}","write_window_end":${END},"write_window_start":${START}}`
    expect(parseRagApprovalPayload(endFirst, 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
  })

  it('refuses an extra key and a missing key', () => {
    expect(parseRagApprovalPayload(good.replace(/\}$/, ',"x":1}'), 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
    const missing = `{"kind":"rag_production_d","package_sha256":"${PKG}","run_id":"${RUN}","write_window_start":${START}}`
    expect(parseRagApprovalPayload(missing, 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
  })

  it('refuses whitespace and escaped spellings that parse to the same values', () => {
    expect(parseRagApprovalPayload(good.replace(',', ', '), 'rag_production_d')).toMatchObject({ ok: false })
    expect(parseRagApprovalPayload(` ${good}`, 'rag_production_d')).toMatchObject({ ok: false })
    expect(parseRagApprovalPayload(`${good}\n`, 'rag_production_d')).toMatchObject({ ok: false })
    // "a" decodes to "a": the values are valid, the text is not canonical.
    const escaped = good.replace(RUN, '0123456789\\u0061bcdef0123456789abcdef')
    expect(parseRagApprovalPayload(escaped, 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
  })

  it('refuses non-JSON, non-object and empty input', () => {
    for (const bad of ['', 'nope', '[]', 'null', '"x"', '12', undefined, null, 5]) {
      expect(parseRagApprovalPayload(bad, 'rag_production_d').ok).toBe(false)
    }
  })

  it('refuses uppercase or short or long package_sha256', () => {
    expect(parseRagApprovalPayload(text({ package_sha256: PKG.toUpperCase() }), 'rag_production_d')).toMatchObject({ ok: false, field: 'package_sha256' })
    expect(parseRagApprovalPayload(text({ package_sha256: 'A' + PKG.slice(1) }), 'rag_production_d')).toMatchObject({ ok: false, field: 'package_sha256' })
    expect(parseRagApprovalPayload(text({ package_sha256: PKG.slice(1) }), 'rag_production_d')).toMatchObject({ ok: false, field: 'package_sha256' })
    expect(parseRagApprovalPayload(text({ package_sha256: PKG + 'a' }), 'rag_production_d')).toMatchObject({ ok: false, field: 'package_sha256' })
    expect(parseRagApprovalPayload(text({ package_sha256: 5 }), 'rag_production_d')).toMatchObject({ ok: false, field: 'package_sha256' })
  })

  it('refuses a run_id that is 31 or 33 chars, uppercase, non-hex or Unicode', () => {
    const bad = [
      RUN.slice(1), RUN + 'a', RUN.toUpperCase(), 'g'.repeat(32),
      '0123456789abcdef0123456789abcdeé', // 32 code points, last is e-acute
      '0123456789abcdef0123456789abcde١', // Arabic-Indic digit one
      '０'.repeat(32), // fullwidth zeros
      `${RUN.slice(0, 31)}\n`, // regex $ must not accept a trailing newline
      '', 7,
    ]
    for (const run_id of bad) {
      expect(parseRagApprovalPayload(text({ run_id }), 'rag_production_d'), JSON.stringify(run_id)).toMatchObject({ ok: false, field: 'run_id' })
    }
  })

  it('refuses a non-integer window: float, negative, zero, string, null, huge', () => {
    for (const v of [1792000000.5, -1, 0, '1792000000', null, true, 2 ** 60]) {
      expect(parseRagApprovalPayload(text({ write_window_start: v }), 'rag_production_d'), `start ${String(v)}`).toMatchObject({ ok: false, field: 'write_window_start' })
      expect(parseRagApprovalPayload(text({ write_window_end: v }), 'rag_production_d'), `end ${String(v)}`).toMatchObject({ ok: false })
    }
  })

  it('refuses NaN and Infinity (JSON.stringify turns them into null; raw text is not JSON)', () => {
    expect(parseRagApprovalPayload(text({ write_window_end: NaN }), 'rag_production_d')).toMatchObject({ ok: false, field: 'write_window_end' })
    const raw = good.replace(String(END), 'NaN')
    expect(parseRagApprovalPayload(raw, 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
    expect(parseRagApprovalPayload(good.replace(String(END), 'Infinity'), 'rag_production_d').ok).toBe(false)
  })

  it('refuses a float spelling of an integer in the text (1792000000.0)', () => {
    expect(parseRagApprovalPayload(good.replace(`:${END}`, `:${END}.0`), 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
    expect(parseRagApprovalPayload(good.replace(`:${END}`, `:${END}e0`), 'rag_production_d')).toMatchObject({ ok: false, field: 'action_payload' })
  })

  it('window: end = start refused, end < start refused, 21600 s accepted, 21601 s refused', () => {
    expect(parseRagApprovalPayload(text({ write_window_start: START, write_window_end: START }), 'rag_production_d')).toMatchObject({ ok: false, field: 'write_window_end' })
    expect(parseRagApprovalPayload(text({ write_window_start: START, write_window_end: START - 1 }), 'rag_production_d')).toMatchObject({ ok: false, field: 'write_window_end' })
    expect(parseRagApprovalPayload(text({ write_window_start: START, write_window_end: START + 1 }), 'rag_production_d').ok).toBe(true)
    expect(parseRagApprovalPayload(text({ write_window_start: START, write_window_end: START + 21600 }), 'rag_production_d').ok).toBe(true)
    expect(parseRagApprovalPayload(text({ write_window_start: START, write_window_end: START + 21601 }), 'rag_production_d')).toMatchObject({ ok: false, field: 'write_window_end' })
  })

  it('does not apply the "end is in the future" rule (a consume sees a half-over window)', () => {
    expect(parseRagApprovalPayload(text({ write_window_start: 100, write_window_end: 200 }), 'rag_production_d').ok).toBe(true)
  })
})

describe('validateRagApprovalRequest', () => {
  const req = (over: Partial<Parameters<typeof validateRagApprovalRequest>[0]> = {}) =>
    validateRagApprovalRequest({ category: 'rag_production_d', actionPayload: good, contentHash: ragPayloadContentHash(good), nowSec: NOW, ...over })

  it('accepts a good request for both categories', () => {
    expect(req().ok).toBe(true)
    const probe = text({}, 'permission_bot_probe')
    expect(req({ category: 'permission_bot_probe', actionPayload: probe, contentHash: ragPayloadContentHash(probe) }).ok).toBe(true)
  })

  it('content_hash is the sha256 of the UTF-8 payload text', () => {
    expect(ragPayloadContentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('refuses a missing, malformed, uppercase or wrong content_hash', () => {
    const h = ragPayloadContentHash(good)
    for (const contentHash of [undefined, null, '', h.slice(1), h.toUpperCase(), 'cd'.repeat(32)]) {
      expect(req({ contentHash }), String(contentHash)).toMatchObject({ ok: false, field: 'content_hash' })
    }
  })

  it('refuses a foreign category under the reserved prefix', () => {
    expect(req({ category: 'rag_production_e' })).toMatchObject({ ok: false, field: 'category' })
    expect(req({ category: 'rag_production_' })).toMatchObject({ ok: false, field: 'category' })
  })

  it('refuses a window that has ended or ends exactly now; accepts one second left', () => {
    expect(req({ nowSec: END })).toMatchObject({ ok: false, field: 'write_window_end' })
    expect(req({ nowSec: END + 1 })).toMatchObject({ ok: false, field: 'write_window_end' })
    expect(req({ nowSec: END - 1 }).ok).toBe(true)
  })
})
