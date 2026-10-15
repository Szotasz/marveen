import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  parseEnvelopePayload, computeContentAnchor, canonicalAnchorJson, envelopeBinding, isEnvelopeBound,
  type AnchorFields, type EnvelopeAttachment,
} from '../approval-envelope.js'

// The server shows a letter and offers buttons for it only
// when the payload hashes to the approval's content_hash the way the SEND GATE
// hashes it. The parity suite therefore runs the gate's own content_anchor
// (loaded with importlib, the gate file untouched) on every vector and demands
// the same hex from the TS port; a lone surrogate must be unhashable on both.
const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py')

const PY_ANCHOR = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("marveen_email_approval_gate", sys.argv[1])',
  'gate = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(gate)',
  'out = []',
  'for env in json.loads(sys.stdin.buffer.read().decode("utf-8")):',
  '    try:',
  '        out.append(gate.content_anchor(env))',
  '    except UnicodeEncodeError:',
  '        out.append(None)',
  'sys.stdout.write(json.dumps(out))',
].join('\n')

function pythonAnchors(vectors: AnchorFields[]): (string | null)[] {
  const res = spawnSync('python3', ['-I', '-c', PY_ANCHOR, GATE], {
    input: JSON.stringify(vectors),
    encoding: 'utf-8',
    timeout: 60_000,
  })
  if (res.status !== 0) {
    console.error(res.stdout)
    console.error(res.stderr)
  }
  expect(res.status).toBe(0)
  return JSON.parse(res.stdout) as (string | null)[]
}

const H1 = '0123456789abcdef'.repeat(4)
const H2 = 'fedcba9876543210'.repeat(4)
const ATT_A: EnvelopeAttachment = { name: 'ajánlat.pdf', sha256: H1, size: 48213 }
const ATT_B: EnvelopeAttachment = { name: 'melléklet 2.docx', sha256: H2, size: 0 }

let controls = ''
for (let c = 0; c < 0x20; c++) controls += String.fromCharCode(c)

const FIXED: { label: string; env: AnchorFields }[] = [
  { label: 'ascii minimal', env: { to: ['a@b.example.com'], cc: [], text: 'Subject\nBody' } },
  { label: 'hungarian accents', env: { to: ['Árvíztűrő Tükörfúrógép <arviz@pelda.example.com>'], cc: ['őű@pelda.example.com'], text: 'Tárgy: ÁÉÍÓÖŐÚÜŰ\náéíóöőúüű' } },
  { label: 'emoji incl. ZWJ and flags', env: { to: ['x@y.example.com'], cc: [], text: 'Szia 👋🏽 👨‍👩‍👧 🇭🇺 😀\n🎉' } },
  { label: 'CRLF and tab', env: { to: ['x@y.example.com'], cc: [], text: 'line1\r\nline2\tcol\r\n\ttrailing\r' } },
  { label: 'all C0 controls', env: { to: ['x@y.example.com'], cc: [], text: 'c:' + controls + ':end' } },
  { label: 'NUL in recipient', env: { to: ['x\u0000@y.example.com'], cc: [], text: 'nul' } },
  { label: 'quote and backslash', env: { to: ['"Kiss, Péter" <k@p.example.com>'], cc: ['a\\b@c.example.com'], text: 'say "hi" \\ path C:\\temp\\x "\\"' } },
  { label: 'DEL, C1, U+2028/2029, BOM, private use, U+FFFF', env: { to: ['x@y.example.com'], cc: [], text: 'del\u007f c1\u0085\u009f ls\u2028ps\u2029 bom\ufeff pua\ue000 max\uffff' } },
  { label: 'bidi controls and slash/html chars', env: { to: ['\u202eevil@y.example.com', 'a/b@<c>&d\'e'], cc: [], text: '</script>\u2066x\u2069 \u200b' } },
  { label: 'empty bcc (excluded)', env: { to: ['x@y.example.com'], cc: [], bcc: [], text: 't' } },
  { label: 'non-empty bcc', env: { to: ['x@y.example.com'], cc: ['c@y.example.com'], bcc: ['rejtett@y.example.com', 'második@y.example.com'], text: 't' } },
  { label: 'html_sha256', env: { to: ['x@y.example.com'], cc: [], text: 't', html_sha256: H1 } },
  { label: 'sorted attachments', env: { to: ['x@y.example.com'], cc: [], text: 't', attachments: [ATT_A, ATT_B] } },
  { label: 'unsorted attachments (order hashed as given)', env: { to: ['x@y.example.com'], cc: [], text: 't', attachments: [ATT_B, ATT_A] } },
  { label: 'everything', env: { to: ['a@b.example.com', 'c@d.example.com'], cc: ['e@f.example.com'], bcc: ['g@h.example.com'], text: 'Tárgy\nTörzs 😀', html_sha256: H2, attachments: [ATT_A] } },
  { label: 'large attachment size', env: { to: ['x@y.example.com'], cc: [], text: 't', attachments: [{ name: 'big.bin', sha256: H1, size: 2 ** 40 + 7 }] } },
  { label: 'connector messageId recipient', env: { to: ['messageId:18f2a9c0d1e2b3a4'], cc: [], text: 'reply body' } },
  { label: 'empty text', env: { to: ['x@y.example.com'], cc: [], text: '' } },
  { label: '20000-char emoji text', env: { to: ['x@y.example.com'], cc: [], text: '😀á\n'.repeat(5000) } },
]

const LONE: { label: string; env: AnchorFields }[] = [
  { label: 'lone high surrogate in text', env: { to: ['x@y.example.com'], cc: [], text: 'a\ud83db' } },
  { label: 'lone low surrogate in text', env: { to: ['x@y.example.com'], cc: [], text: 'a\ude00b' } },
  { label: 'reversed pair', env: { to: ['x@y.example.com'], cc: [], text: '\ude00\ud83d' } },
  { label: 'high surrogate at end', env: { to: ['x@y.example.com'], cc: [], text: 'end\ud800' } },
  { label: 'lone surrogate in to', env: { to: ['x\udfff@y.example.com'], cc: [], text: 't' } },
  { label: 'lone surrogate in bcc', env: { to: ['x@y.example.com'], cc: [], bcc: ['\ud800'], text: 't' } },
  { label: 'lone surrogate in attachment name', env: { to: ['x@y.example.com'], cc: [], text: 't', attachments: [{ name: 'a\udbff.pdf', sha256: H1, size: 1 }] } },
]

// Seeded, so a parity failure reproduces.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const POOL: string[] = [
  ...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)),
  ' ', '!', '"', '\\', '/', '<', '>', '&', "'", '@', ',', ':', '{', '}', '[', ']', 'a', 'Z', '0', '9', '\u007f',
  'á', 'ő', 'ű', 'Ő', 'Ű', '\u0080', '\u0085', '\u009f', '\u00a0', '\u0301', '中', '文', '\u2028', '\u2029',
  '\u202a', '\u202e', '\u2066', '\u2069', '\u200b', '\u200d', '\ufeff', '\ue000', '\uffff', '\ufffd',
  '😀', '🇭', '🏽', '𝔘', '\u{10ffff}', '\u{1f9d1}',
]

function randomEnv(rnd: () => number): AnchorFields {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
  const str = (max: number) => {
    let s = ''
    const n = Math.floor(rnd() * max)
    for (let i = 0; i < n; i++) s += pick(POOL)
    return s
  }
  const list = (max: number) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => str(24))
  const hex = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('')
  const env: AnchorFields = { to: [str(24) || 'x', ...list(2)], cc: list(2), text: str(200) }
  if (rnd() < 0.5) env.bcc = list(2)
  if (rnd() < 0.3) env.html_sha256 = hex()
  if (rnd() < 0.3) {
    env.attachments = Array.from({ length: Math.floor(rnd() * 3) }, () => ({
      name: str(16), sha256: hex(), size: Math.floor(rnd() * 2 ** 40),
    }))
  }
  return env
}

describe('computeContentAnchor: byte parity with the gate content_anchor', () => {
  it('fixed vectors hash identically to the python gate', () => {
    const py = pythonAnchors(FIXED.map(v => v.env))
    FIXED.forEach((v, i) => {
      expect(py[i], v.label).toMatch(/^[0-9a-f]{64}$/)
      expect(computeContentAnchor(v.env), v.label).toBe(py[i])
    })
  })

  it('300 seeded random vectors hash identically to the python gate', () => {
    const rnd = mulberry32(0x5eed7a11)
    const vectors = Array.from({ length: 300 }, () => randomEnv(rnd))
    const py = pythonAnchors(vectors)
    vectors.forEach((env, i) => {
      expect(py[i], `vector ${i}`).toMatch(/^[0-9a-f]{64}$/)
      expect(computeContentAnchor(env), `vector ${i}: ${JSON.stringify(env)}`).toBe(py[i])
    })
  })

  it('a lone surrogate is unhashable on both sides', () => {
    const py = pythonAnchors(LONE.map(v => v.env))
    LONE.forEach((v, i) => {
      expect(py[i], v.label).toBeNull()
      expect(computeContentAnchor(v.env), v.label).toBeNull()
      expect(canonicalAnchorJson(v.env), v.label).toBeNull()
    })
  })

  it('the canonical text is sorted, compact and raw-unicode', () => {
    expect(canonicalAnchorJson({ to: ['ő@b.example.com'], cc: [], bcc: ['z@b.example.com'], text: 'a\n"b"', html_sha256: H1 }))
      .toBe(`{"bcc":["z@b.example.com"],"cc":[],"html_sha256":"${H1}","text":"a\\n\\"b\\"","to":["ő@b.example.com"]}`)
    expect(canonicalAnchorJson({ to: ['x'], cc: [], text: '\u0001\u001f\b' })).toBe('{"cc":[],"text":"\\u0001\\u001f\\b","to":["x"]}')
    const canon = canonicalAnchorJson({ to: ['x'], cc: [], text: 't' })!
    expect(computeContentAnchor({ to: ['x'], cc: [], text: 't' })).toBe(createHash('sha256').update(canon, 'utf8').digest('hex'))
  })

  it('bcc, html_sha256 and attachments join the anchor only when non-empty', () => {
    const base = { to: ['x@y.example.com'], cc: [], text: 't' }
    const plain = computeContentAnchor(base)
    expect(computeContentAnchor({ ...base, bcc: [] })).toBe(plain)
    expect(computeContentAnchor({ ...base, bcc: null, html_sha256: null, attachments: null })).toBe(plain)
    expect(computeContentAnchor({ ...base, html_sha256: '' })).toBe(plain)
    expect(computeContentAnchor({ ...base, attachments: [] })).toBe(plain)
    expect(computeContentAnchor({ ...base, bcc: ['b@y.example.com'] })).not.toBe(plain)
    expect(computeContentAnchor({ ...base, html_sha256: H1 })).not.toBe(plain)
    expect(computeContentAnchor({ ...base, attachments: [ATT_A] })).not.toBe(plain)
  })

  it('a value the gate could not have produced is unhashable, not approximated', () => {
    const base = { to: ['x@y.example.com'], cc: [], text: 't' }
    expect(computeContentAnchor({ ...base, attachments: [{ name: 'a', sha256: H1, size: 2 ** 53 }] })).toBeNull()
    expect(computeContentAnchor({ ...base, attachments: [{ name: 'a', sha256: H1, size: 1.5 }] })).toBeNull()
    expect(computeContentAnchor({ ...base, attachments: [{ name: 'a', sha256: H1, size: -1 }] })).toBeNull()
    expect(computeContentAnchor({ ...base, to: [1 as unknown as string] })).toBeNull()
    expect(computeContentAnchor({ ...base, cc: 'c@y.example.com' as unknown as string[] })).toBeNull()
    expect(computeContentAnchor({ ...base, bcc: [null as unknown as string] })).toBeNull()
    expect(computeContentAnchor({ ...base, text: 5 as unknown as string })).toBeNull()
    expect(computeContentAnchor({ ...base, html_sha256: 7 as unknown as string })).toBeNull()
    const att = (a: unknown) => ({ ...base, attachments: [a as EnvelopeAttachment] })
    expect(computeContentAnchor(att({ name: 'a', sha256: H1, size: 1, path: '/x' }))).toBeNull()
    expect(computeContentAnchor(att({ name: 'a', sha256: H1 }))).toBeNull()
    expect(computeContentAnchor(att({ name: 1, sha256: H1, size: 1 }))).toBeNull()
    expect(computeContentAnchor(att({ name: 'a', sha256: H1, size: '1' }))).toBeNull()
  })
})

function payload(over: Record<string, unknown> = {}, drop: string[] = []): string {
  const obj: Record<string, unknown> = { envelope_v: 1, to: ['x@y.example.com'], cc: [], bcc: [], text: 'Tárgy\nTörzs', ...over }
  for (const k of drop) delete obj[k]
  return JSON.stringify(obj)
}

describe('parseEnvelopePayload: strict', () => {
  it('accepts a minimal envelope and defaults bcc to []', () => {
    expect(parseEnvelopePayload(payload({}, ['bcc']))).toEqual({ envelope_v: 1, to: ['x@y.example.com'], cc: [], bcc: [], text: 'Tárgy\nTörzs' })
    expect(parseEnvelopePayload(payload({ bcc: null }))?.bcc).toEqual([])
  })

  it('accepts a full envelope and keeps every field exactly', () => {
    const env = parseEnvelopePayload(payload({
      to: ['a@b.example.com', 'c@d.example.com'], cc: ['e@f.example.com'], bcc: ['g@h.example.com'], text: 'Tárgy\r\nTörzs 😀\u0000',
      subject: 'Tárgy', html_sha256: H1, attachments: [ATT_A, ATT_B],
    }))
    expect(env).toEqual({
      envelope_v: 1, to: ['a@b.example.com', 'c@d.example.com'], cc: ['e@f.example.com'], bcc: ['g@h.example.com'], text: 'Tárgy\r\nTörzs 😀\u0000',
      subject: 'Tárgy', html_sha256: H1, attachments: [ATT_A, ATT_B],
    })
  })

  it('treats null optionals as absent and drops an empty attachment list', () => {
    const env = parseEnvelopePayload(payload({ subject: null, html_sha256: null, attachments: [] }))!
    expect(env).not.toHaveProperty('subject')
    expect(env).not.toHaveProperty('html_sha256')
    expect(env).not.toHaveProperty('attachments')
  })

  it('accepts an escaped, well-formed surrogate pair', () => {
    expect(parseEnvelopePayload('{"envelope_v":1,"to":["x@y.example.com"],"cc":[],"text":"\\ud83d\\ude00"}')?.text).toBe('😀')
  })

  const bad: [string, string | null | undefined][] = [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['not JSON', '{envelope_v:1}'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON number', '1'],
    ['JSON string', '"x"'],
    ['leading BOM', '\ufeff' + payload()],
    ['missing envelope_v', payload({}, ['envelope_v'])],
    ['envelope_v 2', payload({ envelope_v: 2 })],
    ['envelope_v "1"', payload({ envelope_v: '1' })],
    ['envelope_v true', payload({ envelope_v: true })],
    ['unknown key', payload({ reply_to: 'z@y.example.com' })],
    ['__proto__ key', '{"envelope_v":1,"to":["x@y.example.com"],"cc":[],"text":"t","__proto__":{}}'],
    ['missing to', payload({}, ['to'])],
    ['to is a string', payload({ to: 'x@y.example.com' })],
    ['to holds a number', payload({ to: ['x@y.example.com', 1] })],
    ['to holds null', payload({ to: [null] })],
    ['empty to', payload({ to: [] })],
    ['missing cc', payload({}, ['cc'])],
    ['cc null', payload({ cc: null })],
    ['bcc is a string', payload({ bcc: 'b@y.example.com' })],
    ['missing text', payload({}, ['text'])],
    ['text is a number', payload({ text: 5 })],
    ['blank text', payload({ text: ' \n\t' })],
    ['subject is a number', payload({ subject: 1 })],
    ['html_sha256 uppercase', payload({ html_sha256: H1.toUpperCase() })],
    ['html_sha256 63 chars', payload({ html_sha256: H1.slice(1) })],
    ['html_sha256 empty', payload({ html_sha256: '' })],
    ['attachments is an object', payload({ attachments: ATT_A })],
    ['attachment with an extra key', payload({ attachments: [{ ...ATT_A, path: '/tmp/a' }] })],
    ['attachment missing size', payload({ attachments: [{ name: 'a', sha256: H1 }] })],
    ['attachment size as string', payload({ attachments: [{ ...ATT_A, size: '10' }] })],
    ['attachment size negative', payload({ attachments: [{ ...ATT_A, size: -1 }] })],
    ['attachment size fractional', payload({ attachments: [{ ...ATT_A, size: 1.5 }] })],
    ['attachment size beyond 2^53', payload({ attachments: [{ ...ATT_A, size: 2 ** 53 }] })],
    ['attachment sha256 bad', payload({ attachments: [{ ...ATT_A, sha256: 'xyz' }] })],
    ['attachment name number', payload({ attachments: [{ ...ATT_A, name: 7 }] })],
    ['lone surrogate in text', '{"envelope_v":1,"to":["x@y.example.com"],"cc":[],"text":"a\\ud800b"}'],
    ['lone surrogate in to', '{"envelope_v":1,"to":["\\udc00@y.example.com"],"cc":[],"text":"t"}'],
    ['lone surrogate in subject', '{"envelope_v":1,"to":["x@y.example.com"],"cc":[],"text":"t","subject":"\\ud800"}'],
    ['lone surrogate in attachment name', `{"envelope_v":1,"to":["x@y.example.com"],"cc":[],"text":"t","attachments":[{"name":"\\udbff","sha256":"${H1}","size":1}]}`],
  ]
  it.each(bad)('rejects: %s', (_label, raw) => {
    expect(parseEnvelopePayload(raw)).toBeNull()
  })
})

describe('envelopeBinding / isEnvelopeBound', () => {
  const env = { to: ['Tulajdonos <g@pelda.example.com>'], cc: ['c@pelda.example.com'], bcc: ['b@pelda.example.com'], text: 'Tárgy\nTörzs 😀', attachments: [ATT_A] }
  const raw = JSON.stringify({ envelope_v: 1, subject: 'Tárgy', ...env })

  it('binds when the payload hashes to the content_hash the python gate computes', () => {
    const [gateHash] = pythonAnchors([env])
    const approval = { category: 'email_send', content_hash: gateHash!, action_payload: raw }
    expect(envelopeBinding(approval)).toEqual({ bound: true, envelope: { envelope_v: 1, subject: 'Tárgy', ...env } })
    expect(isEnvelopeBound(approval)?.text).toBe('Tárgy\nTörzs 😀')
  })

  it('names why an approval is not bound, without hash or content', () => {
    const good = computeContentAnchor(env)!
    const cases: [Record<string, unknown>, string][] = [
      [{ category: 'email_standing_recipient', content_hash: good, action_payload: raw }, 'not_email_send'],
      [{ category: 'email_send', content_hash: null, action_payload: raw }, 'no_content_hash'],
      [{ category: 'email_send', content_hash: good.toUpperCase(), action_payload: raw }, 'no_content_hash'],
      [{ category: 'email_send', content_hash: good, action_payload: null }, 'no_payload'],
      [{ category: 'email_send', content_hash: good, action_payload: '' }, 'no_payload'],
      [{ category: 'email_send', content_hash: good, action_payload: '{"to":["x"]}' }, 'bad_payload'],
      [{ category: 'email_send', content_hash: 'ab'.repeat(32), action_payload: raw }, 'hash_mismatch'],
      // The same letter with one more bcc must not ride on the original approval.
      [{ category: 'email_send', content_hash: good, action_payload: JSON.stringify({ envelope_v: 1, ...env, bcc: ['b@pelda.example.com', 'x@evil.example.com'] }) }, 'hash_mismatch'],
      // One trailing space more in the text is another letter.
      [{ category: 'email_send', content_hash: good, action_payload: JSON.stringify({ envelope_v: 1, ...env, text: 'Tárgy\nTörzs 😀 ' }) }, 'hash_mismatch'],
    ]
    for (const [approval, reason] of cases) {
      const b = envelopeBinding(approval as never)
      expect(b, reason).toEqual({ bound: false, reason })
      expect(isEnvelopeBound(approval as never)).toBeNull()
    }
  })

  it('the subject hint does not take part in the binding', () => {
    const good = computeContentAnchor(env)!
    const other = JSON.stringify({ envelope_v: 1, ...env, subject: 'Egészen más tárgy' })
    expect(isEnvelopeBound({ category: 'email_send', content_hash: good, action_payload: other })?.subject).toBe('Egészen más tárgy')
  })
})
