// APPROVALSLACK1030 (2), Samu 65945: the server recomputes an email_send request's anchor from its envelope with the
// rule scripts/hooks/email-approval-gate.py uses (content_anchor). Shared vectors: every envelope below goes through
// the TS port AND through the real Python function (imported from the hook file), and the two must agree, so a change
// on either side that would make them disagree turns this red.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentAnchor, parseEnvelope, envelopeOfPayload, verifiedEnvelope, envelopeText, canonicalJson, type MailEnvelope } from '../approval-envelope.js'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'hooks', 'email-approval-gate.py')

const VECTORS: Record<string, MailEnvelope> = {
  plain: { to: ['a@example.com'], cc: [], text: 'Tárgy: Szia\n\nRövid levél.' },
  accents_emoji: { to: ['tüttő.sára@example.hu'], cc: ['b@example.com'], text: 'Árvíztűrő tükörfúrógép 🚀 “idézet” — ok' },
  control_chars: { to: ['a@example.com'], cc: [], text: 'tab\there\r\nback\\slash "quote" \u0001\u001f\u007f end' },
  with_bcc: { to: ['a@example.com'], cc: [], bcc: ['hidden@example.com'], text: 'x' },
  empty_optionals_left_out: { to: ['a@example.com'], cc: [], bcc: [], render: '', attachments: [], text: 'x' },
  html_and_attachments: { to: ['a@example.com'], cc: ['c@example.com'], text: 'x', render: 'html', html_sha256: 'ab'.repeat(32),
    attachments: [{ name: 'számla.pdf', sha256: 'cd'.repeat(32) }, { name: 'b.txt', sha256: 'ef'.repeat(32) }] },
  harder_mail: { to: ['a@example.com'], cc: [], text: 'x', account: 'info@example.hu', reply_to: ['INBOX', 4242], body_format: 'html' },
  no_recipients: { to: [], cc: [], text: '' },
}

function pythonAnchors(envs: Record<string, MailEnvelope>): Record<string, string> {
  const code = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("gate", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'envs = json.loads(sys.stdin.read())',
    'print(json.dumps({k: m.content_anchor(v) for k, v in envs.items()}))',
  ].join('\n')
  return JSON.parse(execFileSync('python3', ['-I', '-c', code, HOOK], { input: JSON.stringify(envs), encoding: 'utf-8', timeout: 20_000 }))
}

describe('content_anchor: the TS port and the Python hook agree', () => {
  it('every shared vector gives the same anchor on both sides', () => {
    const py = pythonAnchors(VECTORS)
    for (const [name, env] of Object.entries(VECTORS)) expect(contentAnchor(env), name).toBe(py[name])
  })

  it('an empty optional field is left out, as Python leaves a falsy one out', () => {
    expect(contentAnchor(VECTORS.empty_optionals_left_out)).toBe(contentAnchor({ to: ['a@example.com'], cc: [], text: 'x' }))
  })

  it('each field the anchor covers changes it', () => {
    const base = VECTORS.html_and_attachments
    const variants: MailEnvelope[] = [
      { ...base, to: ['z@example.com'] }, { ...base, cc: [] }, { ...base, bcc: ['x@example.com'] }, { ...base, text: 'y' },
      { ...base, render: 'html-wrap' }, { ...base, html_sha256: 'aa'.repeat(32) }, { ...base, attachments: [] },
      { ...base, account: 'other@example.hu' }, { ...base, reply_to: ['INBOX', 1] }, { ...base, body_format: 'plain' },
    ]
    for (const v of variants) expect(contentAnchor(v)).not.toBe(contentAnchor(base))
  })

  it('canonical JSON sorts keys and uses no spaces, as json.dumps(sort_keys, separators) does', () => {
    expect(canonicalJson({ b: [1, 'x'], a: { d: 'é', c: '"' } })).toBe('{"a":{"c":"\\"","d":"é"},"b":[1,"x"]}')
  })
})

describe('parseEnvelope: only a value the Python rule serialises the same way', () => {
  it('takes the known fields of their own shape', () => {
    expect(parseEnvelope(VECTORS.harder_mail)).toEqual(VECTORS.harder_mail)
    expect(parseEnvelope(VECTORS.html_and_attachments)).toEqual(VECTORS.html_and_attachments)
  })

  it('refuses an unknown field, a wrong type, a float, a lone surrogate, a malformed attachment', () => {
    const bad: unknown[] = [
      null, [], 'x', {}, { to: 'a@example.com', cc: [], text: 'x' }, { to: [], cc: [], text: 1 },
      { to: [], cc: [], text: 'x', extra: 1 }, { to: [], cc: [], text: 'x', reply_to: ['INBOX', 1.5] },
      { to: [], cc: [], text: 'bad \uD800 surrogate' }, { to: [], cc: [], text: 'x', attachments: [{ name: 'a' }] },
      { to: [], cc: [], text: 'x', attachments: [{ name: 'a', sha256: 'b', extra: 'c' }] }, { to: [1], cc: [], text: 'x' },
    ]
    for (const b of bad) expect(parseEnvelope(b), JSON.stringify(b)).toBeNull()
  })
})

describe('verifiedEnvelope: the letter only when its anchor is the request\'s hash', () => {
  const env = VECTORS.accents_emoji
  const payload = JSON.stringify({ envelope: env })
  const hash = contentAnchor(env)

  it('an email_send request whose envelope anchors to its content_hash', () => {
    expect(verifiedEnvelope({ category: 'email_send', action_payload: payload, content_hash: hash })).toEqual(env)
  })

  it('no letter: another hash, no hash, no envelope, a broken payload, another category', () => {
    expect(verifiedEnvelope({ category: 'email_send', action_payload: payload, content_hash: 'f'.repeat(64) })).toBeNull()
    expect(verifiedEnvelope({ category: 'email_send', action_payload: payload, content_hash: null })).toBeNull()
    expect(verifiedEnvelope({ category: 'email_send', action_payload: JSON.stringify({ note: 'x' }), content_hash: hash })).toBeNull()
    expect(verifiedEnvelope({ category: 'email_send', action_payload: '{not json', content_hash: hash })).toBeNull()
    expect(verifiedEnvelope({ category: 'email_send', action_payload: null, content_hash: hash })).toBeNull()
    expect(verifiedEnvelope({ category: 'data_delete', action_payload: payload, content_hash: hash })).toBeNull()
    expect(envelopeOfPayload('[]')).toBeNull()
  })

  it('the owner\'s text shows every covered field and the whole body', () => {
    const t = envelopeText(VECTORS.html_and_attachments, 'h'.repeat(64))
    for (const s of ['Címzett: a@example.com', 'Másolat: c@example.com', 'Megjelenítés: html', `HTML sha256: ${'ab'.repeat(32)}`,
      `számla.pdf (sha256 ${'cd'.repeat(32)})`, 'Szöveg:\nx', `Horgony (sha256): ${'h'.repeat(64)}`]) expect(t).toContain(s)
    expect(envelopeText(VECTORS.with_bcc, 'h')).toContain('Titkos másolat: hidden@example.com')
  })
})
