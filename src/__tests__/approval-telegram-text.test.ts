import { describe, it, expect } from 'vitest'
import {
  buildBoundApprovalMessages,
  formatOutcomeText,
  type BoundApprovalMeta,
  type EnvelopeView,
} from '../web/approval-telegram-text.js'
import { TEST_RUN_PREFIX } from '../test-run-marker.js'

// The notifier passes limit = 4096 - TEST_RUN_PREFIX.length, reserve = 300.
const OPTS = { limit: 4096 - TEST_RUN_PREFIX.length, reserve: 300 }

const META: BoundApprovalMeta = {
  agentId: 'office-agent',
  shortId: 'a1b2c3d4',
  hash8: 'deadbeef',
  timeoutAt: 1_787_300_000 + 3600,
  windowMinutes: 30,
}

function view(over: Partial<EnvelopeView> = {}): EnvelopeView {
  return {
    to: ['ugyfel@example.com'],
    cc: ['colleague@example.com'],
    bcc: [],
    text: 'Tárgy: Ajánlat\n\nKedves Ügyfelünk!\nMellékelten küldjük az ajánlatot.\nÜdv: Ügyfélszolgálat',
    ...over,
  }
}

// Strip the "[JÓVÁHAGYÁS <id> | i/n]\n" header and return [i, n, body].
function parseChunk(c: string): { i: number; n: number; body: string } {
  const m = /^\[JÓVÁHAGYÁS ([0-9a-f]{8}) \| (\d+)\/(\d+)\]\n/.exec(c)
  if (!m) throw new Error('chunk header missing: ' + c.slice(0, 40))
  expect(m[1]).toBe(META.shortId)
  return { i: Number(m[2]), n: Number(m[3]), body: c.slice(m[0].length) }
}

function build(v: EnvelopeView, opts = OPTS) {
  const r = buildBoundApprovalMessages(v, META, opts)
  if ('unfit' in r) throw new Error('unexpected unfit')
  return r
}

// Every message, with the test marker the sender would prepend, fits Telegram.
function expectAllFit(r: { chunks: string[]; final: string }) {
  for (const m of [...r.chunks, r.final]) {
    expect((TEST_RUN_PREFIX + m).length).toBeLessThanOrEqual(4096)
  }
}

function joinedBodies(r: { chunks: string[] }): string {
  return r.chunks.map(c => parseChunk(c).body).join('')
}

// True when no lone surrogate is present (String.isWellFormed is not in the TS lib target).
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

function rnd(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('buildBoundApprovalMessages: short letter', () => {
  it('is one message with zero chunks and every identifying datum', () => {
    const v = view({ subjectHint: 'Tárgy: Ajánlat' })
    const r = build(v)
    expect(r.chunks).toEqual([])
    expect(r.final).toContain(v.text)
    expect(r.final).toContain('office-agent')
    expect(r.final).toContain('Címzett: ugyfel@example.com')
    expect(r.final).toContain('Cc: colleague@example.com')
    expect(r.final).toContain('Bcc: nincs')
    expect(r.final).toContain('a1b2c3d4')
    expect(r.final).toContain('deadbeef')
    expect(r.final).toContain('Lejárat: 2026.')
    expect(r.final).toContain('30 percig, egyszer küldhető el')
    expectAllFit(r)
  })

  it('lists several recipients and bcc in full', () => {
    const r = build(view({ to: ['a@x.example.com', 'b@x.example.com'], cc: ['c@x.example.com'], bcc: ['d@x.example.com', 'e@x.example.com'] }))
    expect(r.final).toContain('Címzett: a@x.example.com, b@x.example.com')
    expect(r.final).toContain('Cc: c@x.example.com')
    expect(r.final).toContain('Bcc: d@x.example.com, e@x.example.com')
  })

  it('null timeoutAt reads "nincs"', () => {
    const r = buildBoundApprovalMessages(view(), { ...META, timeoutAt: null }, OPTS)
    expect('final' in r && r.final).toContain('Lejárat: nincs')
  })

  it('empty text still yields a single message', () => {
    const r = build(view({ text: '' }))
    expect(r.chunks).toEqual([])
  })
})

describe('buildBoundApprovalMessages: subject', () => {
  it('shows the subject when it is exactly the FIRST line of the text, labelled as the first line', () => {
    const r = build(view({ subjectHint: 'Tárgy: Ajánlat' }))
    expect(r.final).toMatch(/^Első sor \(a kérő szerint tárgy\): Tárgy: Ajánlat$/m)
  })

  // On the MCP path, and with --body before --subject, the first
  // line is the BODY's first line. A first-line match proves the position, not
  // that it is a subject, so the line never carries a bare "Tárgy:" label.
  it('a first-line match is never labelled with a bare "Tárgy:"', () => {
    const text = 'Kedves Ügyfelünk!\nMellékelten küldjük.'
    const r = build(view({ text, subjectHint: 'Kedves Ügyfelünk!' }))
    const head = r.final.split('--- A levél szövege ---')[0]
    expect(head).toContain('Első sor (a kérő szerint tárgy): Kedves Ügyfelünk!')
    expect(head).not.toMatch(/^Tárgy: Kedves/m)
    expect(head.split('\n').filter(l => l.startsWith('Tárgy:') || l.startsWith('Első sor')).length).toBe(1)
  })

  it('a text that is the subject alone (no newline): its only line is the first one', () => {
    const r = build(view({ text: 'Ajánlat', subjectHint: 'Ajánlat' }))
    expect(r.final).toMatch(/^Első sor \(a kérő szerint tárgy\): Ajánlat$/m)
  })

  // The extractor joins subject and body with one "\n", the subject
  // FIRST only when it comes first (MCP puts it last). Any later line could be
  // a body line dressed up as the subject.
  it('a later line -- the second, a middle one, the last (where MCP puts the subject) -- is NOT labelled', () => {
    const text = 'Kedves Ügyfelünk!\nAjánlat\nMellékelten küldjük.\nÜdv: Ügyfélszolgálat'
    for (const hint of ['Ajánlat', 'Mellékelten küldjük.', 'Üdv: Ügyfélszolgálat']) {
      const r = build(view({ text, subjectHint: hint }))
      expect(r.final).toContain('Tárgy: a levél szövegében szerepel (nem külön hitelesített mező)')
      const head = r.final.split('--- A levél szövege ---')[0]
      expect(head).not.toContain(`Tárgy: ${hint}`)
    }
  })

  it('CRLF: the first line runs to the first "\\n", so a CR stays part of it', () => {
    const plain = build(view({ text: 'Ajánlat\r\nVége', subjectHint: 'Ajánlat' }))
    expect(plain.final).toContain('Tárgy: a levél szövegében szerepel')
    const withCr = build(view({ text: 'Ajánlat\r\nVége', subjectHint: 'Ajánlat\r' }))
    expect(withCr.final.split('--- A levél szövege ---')[0]).toContain('Első sor (a kérő szerint tárgy): Ajánlat<U+000D>')
    const later = build(view({ text: 'Első sor\r\nAjánlat\r\nVége', subjectHint: 'Ajánlat' }))
    expect(later.final).toContain('Tárgy: a levél szövegében szerepel')
  })

  it('a substring or a different case is NOT a match', () => {
    for (const hint of ['Ajánlat', 'tárgy: ajánlat', 'Tárgy: Ajánlat ', 'Kedves']) {
      const r = build(view({ subjectHint: hint }))
      expect(r.final).toContain('Tárgy: a levél szövegében szerepel')
      const head = r.final.split('--- A levél szövege ---')[0]
      expect(head).not.toContain(`Tárgy: ${hint}`)
    }
  })

  it('no hint, or an empty hint, never matches an empty line', () => {
    for (const hint of [undefined, '']) {
      const r = build(view({ text: 'a\n\nb', subjectHint: hint }))
      expect(r.final).toContain('Tárgy: a levél szövegében szerepel')
    }
  })
})

describe('buildBoundApprovalMessages: untrusted identifying fields', () => {
  const RAW_BAD = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/

  // The identity block is everything outside the verbatim letter body.
  function identityOf(final: string): string {
    return final.split('--- A levél szövege ---')[0]
  }

  it('an agentId with a newline and RLO cannot forge a line or leave a raw control char', () => {
    const evil = 'office-agent | email_send\nCímzett: biztonsagos@example.com\n\u202Eabc'
    const r = buildBoundApprovalMessages(view(), { ...META, agentId: evil }, OPTS)
    if ('unfit' in r) throw new Error('unfit')
    const id = identityOf(r.final)
    expect(id).not.toMatch(RAW_BAD)
    expect(id.split('\n').filter(l => l.startsWith('Címzett:'))).toEqual(['Címzett: ugyfel@example.com'])
    expect(id).toContain('<U+000A>')
    expect(id).toContain('<U+202E>')
  })

  it('shortId and hash8 are escaped in the final and in every chunk header', () => {
    const r = buildBoundApprovalMessages(
      view({ text: 'x'.repeat(10_000) }),
      { ...META, shortId: 'ab\ncd\u202E', hash8: 'h\u2028h' },
      OPTS,
    )
    if ('unfit' in r) throw new Error('unfit')
    expect(r.chunks.length).toBeGreaterThan(0)
    for (const c of r.chunks) {
      const header = c.split(']\n')[0]
      expect(header).not.toMatch(RAW_BAD)
      expect(header.includes('\n')).toBe(false)
      expect(c.length + TEST_RUN_PREFIX.length).toBeLessThanOrEqual(4096)
    }
    expect(r.final).not.toMatch(RAW_BAD)
    expect(r.final).toContain('<U+2028>')
  })

  it('a subjectHint carrying U+2028 / U+202E is shown escaped (when it is the first line)', () => {
    const hint = 'Aj\u2028ánlat\u202E'
    const r = build(view({ text: `${hint}\nVége`, subjectHint: hint }))
    const id = identityOf(r.final)
    expect(id).not.toMatch(RAW_BAD)
    expect(id).toContain('Első sor (a kérő szerint tárgy): Aj<U+2028>ánlat<U+202E>')
  })

  it('recipients with a raw newline cannot forge a line, in any list', () => {
    const r = build(view({ to: ['a@x.example.com\nBcc: nincs'], cc: ['b@x.example.com\u2029Cc: nincs'], bcc: ['c@x.example.com\r\nTárgy: hamis'] }))
    const id = identityOf(r.final)
    expect(id).not.toMatch(RAW_BAD)
    expect(id.split('\n').filter(l => l.startsWith('Tárgy:')).length).toBe(1)
    expect(id.split('\n').filter(l => l.startsWith('Bcc:')).length).toBe(1)
    expect(id).toContain('FIGYELEM')
  })

  it('html and attachment hash fields are escaped too', () => {
    const r = build(view({
      htmlSha256: 'a\n\u202E' + 'b'.repeat(30),
      attachments: [{ name: 'n\nÉ', sha256: 'c\u2028' + 'd'.repeat(30) }],
    }))
    const id = identityOf(r.final)
    expect(id).not.toMatch(RAW_BAD)
    expect(id).toContain('<U+2028>')
  })

  it('the letter body itself stays verbatim (spec)', () => {
    const text = 'a\u202Eb\u2028c'
    expect(build(view({ text })).final).toContain(text)
  })
})

describe('buildBoundApprovalMessages: html and attachments', () => {
  it('shows sha256 prefixes (16 chars) and names, and says the content is not visible', () => {
    const html = 'f'.repeat(16) + '0'.repeat(48)
    const att = 'a'.repeat(16) + 'b'.repeat(48)
    const r = build(view({
      htmlSha256: html,
      attachments: [{ name: 'ajanlat.pdf', sha256: att, size: 1234 }],
    }))
    expect(r.final).toContain(`HTML-törzs sha256: ${'f'.repeat(16)}`)
    expect(r.final).not.toContain('f'.repeat(17))
    expect(r.final).toContain(`Melléklet: ajanlat.pdf | sha256: ${'a'.repeat(16)}`)
    expect(r.final).not.toContain('a'.repeat(17))
    expect(r.final).toContain('tartalma itt nem látszik')
  })

  it('omits the section when there is neither', () => {
    const r = build(view())
    expect(r.final).not.toContain('Melléklet')
    expect(r.final).not.toContain('HTML-törzs')
    expect(r.final).not.toContain('nem látszik')
  })

  it('renders control and bidi characters of a file name visibly', () => {
    const r = build(view({ attachments: [{ name: 'a‮gpj.exe', sha256: 'c'.repeat(64) }] }))
    expect(r.final).not.toContain('‮')
    expect(r.final).toContain('<U+202E>')
  })
})

describe('buildBoundApprovalMessages: address warning', () => {
  it('warns on a non-ASCII address and shows it escaped', () => {
    const r = build(view({ to: ['józsi@példa.example.com'] }))
    expect(r.final).toContain('FIGYELEM')
    expect(r.final).toContain('j<U+00F3>zsi@p<U+00E9>lda.example.com')
  })

  it('warns on a bidi control character and never prints it raw in the lists', () => {
    const r = build(view({ cc: ['x‮y@example.com'] }))
    expect(r.final).toContain('FIGYELEM')
    expect(r.final).not.toContain('‮')
    expect(r.final).toContain('x<U+202E>y@example.com')
  })

  it('warns for bcc too', () => {
    const r = build(view({ bcc: ['b​cc@example.com'] }))
    expect(r.final).toContain('FIGYELEM')
  })

  it('no warning for plain ASCII addresses', () => {
    expect(build(view()).final).not.toContain('FIGYELEM')
  })

  it('the warning also lands in the final message of a chunked letter', () => {
    const r = build(view({ to: ['józsi@példa.example.com'], text: 'x'.repeat(10_000) }))
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(r.final).toContain('FIGYELEM')
  })
})

describe('buildBoundApprovalMessages: chunking', () => {
  it('splits a long letter into numbered chunks, 1..n, and the bodies rejoin to the text', () => {
    const text = 'Sor egy\n'.repeat(2000)
    const r = build(view({ text }))
    expect(r.chunks.length).toBeGreaterThan(1)
    r.chunks.forEach((c, idx) => {
      const p = parseChunk(c)
      expect(p.i).toBe(idx + 1)
      expect(p.n).toBe(r.chunks.length)
    })
    expect(joinedBodies(r)).toBe(text)
    expectAllFit(r)
  })

  it('the text is NOT repeated in the final message of a chunked letter', () => {
    const text = 'Egyedi-mondat-123\n'.repeat(1000)
    const r = build(view({ text }))
    expect(r.final).not.toContain('Egyedi-mondat-123')
    expect(r.final).toContain(`előző ${r.chunks.length} üzenetben`)
  })

  it('the final message identifies the letter on its own', () => {
    const r = build(view({ to: ['a@x.example.com'], cc: ['c@x.example.com'], bcc: ['d@x.example.com'], subjectHint: 'Ajánlat', text: 'Ajánlat\n' + 'x'.repeat(9000) }))
    expect(r.chunks.length).toBeGreaterThan(0)
    for (const needle of [
      'office-agent', 'Címzett: a@x.example.com', 'Cc: c@x.example.com', 'Bcc: d@x.example.com', 'Első sor (a kérő szerint tárgy): Ajánlat',
      'a1b2c3d4', 'deadbeef', 'Lejárat: 2026.', '30 percig, egyszer küldhető el',
    ]) {
      expect(r.final).toContain(needle)
    }
    expectAllFit(r)
  })

  it('a letter that fits only without the reserve is chunked (reserve counts)', () => {
    const base = build(view({ text: '' })).final.length
    // Single message would be exactly limit - reserve + 1 long: must chunk.
    const filler = OPTS.limit - OPTS.reserve - base + 1
    const r = build(view({ text: 'x'.repeat(Math.max(filler, 1)) }))
    const single = build(view({ text: 'x'.repeat(Math.max(filler - 400, 1)) }))
    expect(single.chunks).toEqual([])
    expect(r.chunks.length).toBeGreaterThan(0)
    expect(joinedBodies(r)).toBe('x'.repeat(Math.max(filler, 1)))
  })

  it('boundary sizes 4095/4096/4097 and the single-message edge all rejoin and fit', () => {
    for (const len of [4095, 4096, 4097, 8192, 8193]) {
      const text = 'é'.repeat(len)
      const r = build(view({ text }))
      expect(r.chunks.length).toBeGreaterThan(0)
      expect(joinedBodies(r)).toBe(text)
      expectAllFit(r)
    }
  })

  it('a tight custom limit still rejoins exactly', () => {
    const text = 'abc def\nghi jkl\n'.repeat(500)
    const r = build(view({ text }), { limit: 900, reserve: 50 })
    expect(joinedBodies(r)).toBe(text)
    for (const m of [...r.chunks, r.final]) expect(m.length).toBeLessThanOrEqual(900)
  })

  it('never cuts a surrogate pair (20 000 chars of emoji)', () => {
    const text = '😀'.repeat(10_000) // 20 000 UTF-16 units
    expect(text.length).toBe(20_000)
    const r = build(view({ text }))
    expect(r.chunks.length).toBeGreaterThan(4)
    for (const c of r.chunks) {
      const body = parseChunk(c).body
      const first = body.charCodeAt(0)
      const last = body.charCodeAt(body.length - 1)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false) // starts with a low surrogate
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false) // ends with a high surrogate
      expect(wellFormed(body)).toBe(true)
    }
    expect(joinedBodies(r)).toBe(text)
    expectAllFit(r)
  })

  it('emoji at every possible cut offset: bodies stay well-formed and rejoin', () => {
    for (const lead of ['', 'a', 'ab']) {
      const text = lead + '😀'.repeat(6000)
      const r = build(view({ text }), { limit: 700, reserve: 50 })
      for (const c of r.chunks) expect(wellFormed(parseChunk(c).body)).toBe(true)
      expect(joinedBodies(r)).toBe(text)
    }
  })

  it('prefers a line break in the second half of the window', () => {
    const line = 'x'.repeat(99) + '\n'
    const text = line.repeat(200) // 20 000 chars, newline every 100
    const r = build(view({ text }))
    for (const c of r.chunks.slice(0, -1)) {
      expect(parseChunk(c).body.endsWith('\n')).toBe(true)
    }
    expect(joinedBodies(r)).toBe(text)
  })

  it('cuts mid-line when there is no newline in the second half', () => {
    const text = '\n' + 'y'.repeat(12_000)
    const r = build(view({ text }))
    expect(r.chunks.length).toBeGreaterThan(1)
    // The newline at offset 0 must not make the first body a 1-char chunk.
    expect(parseChunk(r.chunks[0]).body.length).toBeGreaterThan(1000)
    expect(joinedBodies(r)).toBe(text)
    expectAllFit(r)
  })

  it('preserves a body that starts with a newline and CRLF text', () => {
    const text = '\n\r\n' + 'z\r\n'.repeat(3000)
    const r = build(view({ text }))
    expect(joinedBodies(r)).toBe(text)
  })

  it('random texts: rejoin, fit, numbering', () => {
    const rand = rnd(42)
    const alphabet = ['a', 'é', 'ő', '\n', ' ', '😀', '𝒳', '\r\n', 'Ű', '中']
    for (let k = 0; k < 40; k++) {
      const len = Math.floor(rand() * 30_000)
      let text = ''
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)]
      const r = build(view({ text }))
      if (r.chunks.length === 0) expect(r.final).toContain(text)
      else expect(joinedBodies(r)).toBe(text)
      expectAllFit(r)
      r.chunks.forEach((c, idx) => {
        const p = parseChunk(c)
        expect(p.i).toBe(idx + 1)
        expect(p.n).toBe(r.chunks.length)
        expect(wellFormed(p.body)).toBe(true)
      })
    }
  })

  it('digit-width rollover (n crosses 9 -> 10 and 99 -> 100): exact counts, wide headers, limit held', () => {
    const limit = 700
    for (const n of [9, 10, 11, 99, 100, 101]) {
      const d = String(n).length
      const header = `[JÓVÁHAGYÁS ${META.shortId} | ${'9'.repeat(d)}/${'9'.repeat(d)}]\n`
      const bodyLimit = limit - header.length
      const text = 'q'.repeat(n * bodyLimit)
      const r = build(view({ text }), { limit, reserve: 10 })
      expect(r.chunks.length).toBe(n)
      expect(r.chunks[0].startsWith(`[JÓVÁHAGYÁS ${META.shortId} | 1/${n}]\n`)).toBe(true)
      expect(r.chunks[n - 1].startsWith(`[JÓVÁHAGYÁS ${META.shortId} | ${n}/${n}]\n`)).toBe(true)
      expect(joinedBodies(r)).toBe(text)
      for (const c of r.chunks) expect(c.length).toBeLessThanOrEqual(limit)
    }
    // One unit over the 99-chunk capacity pushes n to 3 digits.
    const d2 = limit - `[JÓVÁHAGYÁS ${META.shortId} | 99/99]\n`.length
    const over = build(view({ text: 'q'.repeat(99 * d2 + 1) }), { limit, reserve: 10 })
    expect(over.chunks.length).toBeGreaterThanOrEqual(100)
    expect(parseChunk(over.chunks[0]).n).toBe(over.chunks.length)
    expect(over.chunks[0]).toMatch(/\| 1\/1\d\d\]\n/)
  })
})

describe('buildBoundApprovalMessages: unfit', () => {
  it('returns unfit when even the final message cannot fit', () => {
    const many = Array.from({ length: 400 }, (_, i) => `cimzett-${i}@example.com`)
    const r = buildBoundApprovalMessages(view({ to: many, text: 'x'.repeat(20_000) }), META, OPTS)
    expect(r).toEqual({ unfit: true })
  })

  it('returns unfit when the limit leaves no room for a chunk body', () => {
    const r = buildBoundApprovalMessages(view({ text: 'x'.repeat(5000) }), META, { limit: 20, reserve: 0 })
    expect(r).toEqual({ unfit: true })
  })

  it('a long recipient list that still fits the final message is fine', () => {
    const many = Array.from({ length: 60 }, (_, i) => `cimzett-${i}@example.com`)
    const r = build(view({ to: many, text: 'x'.repeat(20_000) }))
    expect(r.chunks.length).toBeGreaterThan(0)
    for (const a of many) expect(r.final).toContain(a)
  })
})

describe('formatOutcomeText', () => {
  // 2026-10-15 08:12:33 UTC = 10:12:33 Budapest (CEST)
  const ts = Date.UTC(2026, 9, 15, 8, 12, 33) / 1000

  it('approved: Budapest time and the single-send window', () => {
    expect(formatOutcomeText('approved', ts)).toBe(
      '✅ Jóváhagyva: 2026. 10. 15. 10:12:33 (Budapest). A levél 30 percen belül, egyszer küldhető el.',
    )
  })

  it('rejected', () => {
    expect(formatOutcomeText('rejected', ts)).toBe('❌ Elutasítva: 2026. 10. 15. 10:12:33 (Budapest).')
  })

  it('winter time uses CET (UTC+1)', () => {
    const w = Date.UTC(2026, 0, 15, 8, 12, 33) / 1000
    expect(formatOutcomeText('rejected', w)).toContain('2026. 01. 15. 9:12:33')
  })

  it('uses the same date format as the request text (hu-HU, Europe/Budapest)', () => {
    const expected = new Date(ts * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
    expect(formatOutcomeText('approved', ts)).toContain(expected)
  })

  it('a custom window is reflected', () => {
    expect(formatOutcomeText('approved', ts, 15)).toContain('15 percen belül')
  })
})
