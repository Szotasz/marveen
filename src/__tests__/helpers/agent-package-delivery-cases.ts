// The installer's own delivery-level case list (MIOAGENTINSTALL1114, plan 10.1):
// steps 1-6 of Sz-4.4 and S13, in the plan's schema
//   {name, stage, delivery, requestedSlug, expect: {ok: true} | {step, reason}}.
// The deliveries are signed at run time with generated keys (no private key in
// the repo), so the list is built by a function; `keys` is the key list the
// cases are verified against. Each refused case breaks exactly one rule.
import {
  DEFAULT_FILES,
  makeKeyPair,
  makePng,
  makeSignedDelivery,
  makeWebp,
  pngChunk,
  webpChunk,
  type DeliveryInput,
  type TestKeyPair,
} from './make-delivery.js'
import type { Jwk, VerifyReason, VerifyStep } from '../../web/agent-package/verify.js'

export interface DeliveryCase {
  name: string
  stage: 'install' | Array<'upload' | 'install'>
  delivery: Uint8Array
  requestedSlug: string
  expect: { ok: true } | { step: VerifyStep; reason: VerifyReason; detail?: Record<string, unknown> }
}

const SLUG = 'invoice-helper'
type Obj = Record<string, unknown>

/** Replace one segment of a compact JWS. */
const withSegment = (i: number, seg: string) => (jws: string) => {
  const parts = jws.split('.')
  parts[i] = seg
  return parts.join('.')
}
const b64url = (s: string) => Buffer.from(s).toString('base64url')
const filesOf = (p: Obj) => p.files as Obj[]

export function makeDeliveryCases(): { keys: Jwk[]; signer: TestKeyPair; cases: DeliveryCase[] } {
  const signer = makeKeyPair()
  const second = makeKeyPair()
  const foreign = makeKeyPair()
  const keys = [signer.jwk, second.jwk]

  const d = (over: Partial<DeliveryInput> = {}) =>
    makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: SLUG, ...over })
  const tamper = (t: DeliveryInput['tamper'], over: Partial<DeliveryInput> = {}) => d({ ...over, tamper: t })
  const ok = (name: string, delivery: Uint8Array): DeliveryCase => ({
    name,
    stage: 'install',
    delivery,
    requestedSlug: SLUG,
    expect: { ok: true },
  })
  const refused = (
    name: string,
    delivery: Uint8Array,
    step: VerifyStep,
    reason: VerifyReason,
    detail?: Record<string, unknown>,
  ): DeliveryCase => ({
    name,
    stage: 'install',
    delivery,
    requestedSlug: SLUG,
    expect: detail === undefined ? { step, reason } : { step, reason, detail },
  })

  const withSkill = {
    ...DEFAULT_FILES,
    'skills/billing/SKILL.md': '---\nname: billing\ndescription: Reads invoices.\n---\n# Billing\n',
    'skills/billing/references/Rates_2026.md': '# Rates\n\nmail: anna1@example.com\n',
  }

  const cases: DeliveryCase[] = [
    // ---- accepted
    ok('minimal package', d()),
    ok('package with a skill, a reference and a PNG avatar', d({
      files: withSkill,
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
    })),
    ok('WebP avatar without metadata', d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: makeWebp() } })),
    ok('signed by the second key of the list', makeSignedDelivery({ kid: second.kid, privateKey: second.privateKey, slug: SLUG })),
    ok('outer format is informational only', tamper({ document: (doc) => ({ ...doc, format: 'something-else/9' }) })),
    ok('unknown payload key passes', tamper({ payload: (p) => ({ ...p, future_field: { a: 1 } }) })),
    ok('model_hint as a string', d({ modelHint: 'claude-sonnet-5' })),
    ok('exactly 64 text files', d({ files: manyFiles(64) })),
    ok('a text file of exactly 256 KiB', d({ files: { ...DEFAULT_FILES, 'skills/big/SKILL.md': 'a'.repeat(256 * 1024) } })),
    ok('an avatar of exactly 512 KiB', d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: pngOfSize(512 * 1024) } })),

    // ---- step 1: document, header, kid, signature
    refused('document is not UTF-8', new Uint8Array([0x7b, 0xff, 0x7d]), 1, 'bad_document'),
    refused('document is not JSON', new Uint8Array(Buffer.from('not json')), 1, 'bad_document'),
    refused('document is a JSON array', new Uint8Array(Buffer.from('[]')), 1, 'bad_document'),
    refused('manifest_jws missing', tamper({ document: ({ manifest_jws: _x, ...rest }) => rest }), 1, 'bad_document'),
    refused('outer files is not an object', tamper({ document: (doc) => ({ ...doc, files: ['CLAUDE.md'] }) }), 1, 'bad_document'),
    refused('outer file value is not a string', tamper({ document: (doc) => ({ ...doc, files: { ...(doc.files as Obj), 'SOUL.md': 7 } }) }), 1, 'bad_document'),
    refused('outer avatar is not an object', tamper({ document: (doc) => ({ ...doc, avatar: 'avatar.png' }) }), 1, 'bad_document'),
    refused('JWS with two segments', tamper({ jws: (j) => j.split('.').slice(0, 2).join('.') }), 1, 'bad_document'),
    refused('JWS with four segments', tamper({ jws: (j) => `${j}.AAAA` }), 1, 'bad_document'),
    refused('JWS header is not base64url', tamper({ jws: withSegment(0, 'e30=') }), 1, 'bad_document'),
    refused('JWS header is not JSON', tamper({ jws: withSegment(0, b64url('alg')) }), 1, 'bad_document'),
    refused('kid not in the list (signed by a listed key)', tamper({ header: (h) => ({ ...h, kid: foreign.kid }) }), 1, 'unknown_kid'),
    refused('kid missing from the header', tamper({ header: ({ kid: _k, ...rest }) => rest }), 1, 'unknown_kid'),
    refused('kid of a foreign key, signed by that key', makeSignedDelivery({ kid: foreign.kid, privateKey: foreign.privateKey, slug: SLUG }), 1, 'unknown_kid'),
    refused('alg is not EdDSA', tamper({ header: (h) => ({ ...h, alg: 'none' }) }), 1, 'header_mismatch'),
    refused('typ is not the package typ', tamper({ header: (h) => ({ ...h, typ: 'JWT' }) }), 1, 'header_mismatch'),
    refused('typ missing', tamper({ header: ({ typ: _t, ...rest }) => rest }), 1, 'header_mismatch'),
    refused('S13: extra header key crit', tamper({ header: (h) => ({ ...h, crit: ['exp'] }) }), 1, 'header_mismatch'),
    refused('S13: extra header key jku', tamper({ header: (h) => ({ ...h, jku: 'https://example.invalid/keys' }) }), 1, 'header_mismatch'),
    refused('signature bytes flipped', tamper({ jws: (j) => {
      const parts = j.split('.')
      const sig = Buffer.from(parts[2], 'base64url')
      sig[0] ^= 0x01
      parts[2] = sig.toString('base64url')
      return parts.join('.')
    } }), 1, 'bad_signature'),
    refused('listed kid, signed by another key', makeSignedDelivery({ kid: signer.kid, privateKey: foreign.privateKey, slug: SLUG }), 1, 'bad_signature'),
    refused('payload changed after signing', tamper({ jws: (j) => {
      const parts = j.split('.')
      const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Obj
      parts[1] = b64url(JSON.stringify({ ...p, version: '9.9.9' }))
      return parts.join('.')
    } }), 1, 'bad_signature'),
    refused('payload is not even JSON, but the signature fails first', tamper({ jws: withSegment(1, b64url('not json')) }), 1, 'bad_signature'),

    // ---- step 2: payload
    refused('payload is not JSON', tamper({ payloadText: () => 'not json' }), 2, 'bad_payload'),
    refused('payload is a JSON array', tamper({ payloadText: () => '[]' }), 2, 'bad_payload'),
    refused('unknown payload format', tamper({ payload: (p) => ({ ...p, format: 'mio-agent-package/2' }) }), 2, 'unknown_format'),
    refused('payload slug differs from the requested one', d({ slug: 'other-agent' }), 2, 'slug_mismatch'),
    refused('version with a leading zero', d({ version: '1.02.0' }), 2, 'bad_payload'),
    refused('version with two parts', d({ version: '1.0' }), 2, 'bad_payload'),
    refused('min_marveen_version malformed', d({ minMarveenVersion: 'v1.0.0' }), 2, 'bad_payload'),
    refused('files is not an array', tamper({ payload: (p) => ({ ...p, files: {} }) }), 2, 'bad_payload'),
    refused('a files entry without sha256', tamper({ payload: (p) => ({ ...p, files: filesOf(p).map(({ sha256: _s, ...f }) => f) }) }), 2, 'bad_payload'),
    refused('a files entry with an uppercase sha256', tamper({ payload: (p) => ({ ...p, files: filesOf(p).map((f) => ({ ...f, sha256: String(f.sha256).toUpperCase() })) }) }), 2, 'bad_payload'),
    refused('a files entry with a negative size', tamper({ payload: (p) => ({ ...p, files: filesOf(p).map((f) => ({ ...f, size: -1 })) }) }), 2, 'bad_payload'),
    refused('payload avatar is not an object', tamper({ payload: (p) => ({ ...p, avatar: 'avatar.png' }) }), 2, 'bad_payload'),
    refused('payload avatar key missing', tamper({ payload: ({ avatar: _a, ...rest }) => rest }), 2, 'bad_payload'),
    refused('display name is not a string', tamper({ payload: (p) => ({ ...p, agent: { display_name: 5, model_hint: null } }) }), 2, 'bad_payload'),
    refused('connectors is not an array', tamper({ payload: (p) => ({ ...p, connectors: null }) }), 2, 'bad_payload'),
    // The level is the contract's enumeration (Sz-4.3), letter for letter.
    refused('connector level outside the enumeration', d({ connectors: [{ name: 'billing', level: 'optional', reason: 'ok' }] }), 2, 'bad_payload'),
    refused('connector level in another letter case', d({ connectors: [{ name: 'billing', level: 'Required', reason: 'ok' }] }), 2, 'bad_payload'),
    refused('connector level with a trailing NUL', d({ connectors: [{ name: 'billing', level: 'required\u0000', reason: 'ok' }] }), 2, 'bad_payload'),
    refused('connector level with a trailing line break', d({ connectors: [{ name: 'billing', level: 'recommended\n', reason: 'ok' }] }), 2, 'bad_payload'),
    refused('connector level empty', d({ connectors: [{ name: 'billing', level: '', reason: 'ok' }] }), 2, 'bad_payload'),
    refused('second connector level outside the enumeration', d({ connectors: [{ name: 'aa', level: 'required', reason: 'ok' }, { name: 'bb', level: 'requiredrecommended', reason: 'ok' }] }), 2, 'bad_payload'),
    // The connector name is a closed pattern (contract decision, Mira 77967): the slug's strict grammar, 2-40 characters.
    ...([
      ['with a word-initial at sign and a path', '@notes/secret.md'],
      ['with a bang and a backtick', 'bill!`ls`'],
      ['with a bidi override', 'bill‮ing'],
      ['with a NUL', 'bill\u0000ing'],
      ['with an LF', 'bill\ning'],
      ['with a trailing LF', 'billing\n'],
      ['with a space', 'bill ing'],
      ['with an uppercase letter', 'Billing'],
      ['with an underscore', 'bill_ing'],
      ['with a dot', 'bill.ing'],
      ['with a leading hyphen', '-billing'],
      ['with a trailing hyphen', 'billing-'],
      ['with a double hyphen', 'bill--ing'],
      ['of one character', 'b'],
      ['of 41 characters', 'a'.repeat(41)],
      ['empty', ''],
    ] as const).map(([what, name]) =>
      refused(`connector name ${what}`, d({ connectors: [{ name, level: 'required', reason: 'ok' }] }), 2, 'bad_payload')),
    refused('second connector name outside the pattern', d({ connectors: [{ name: 'aa', level: 'required', reason: 'ok' }, { name: 'b\rc', level: 'recommended', reason: 'ok' }] }), 2, 'bad_payload'),
    ok('connector names at both length bounds, with digits and hyphens', d({ connectors: [
      { name: 'ab', level: 'required', reason: 'ok' },
      { name: 'a'.repeat(40), level: 'recommended', reason: 'ok' },
      { name: 'google-drive-2', level: 'recommended', reason: 'ok' },
    ] })),
    // The model hint is a closed pattern too (a model id shape), or null, or absent.
    ...([
      ['with a word-initial at sign', '@notes.md'],
      ['with a zero-width space', 'claude​-sonnet-5'],
      ['with a NUL', 'claude-sonnet-5\u0000'],
      ['with an LF', 'claude-sonnet-5\nx'],
      ['with a trailing LF', 'claude-sonnet-5\n'],
      ['with a CR', 'claude-sonnet-5\rx'],
      ['with a space', 'claude sonnet'],
      ['with an uppercase letter', 'Claude-sonnet-5'],
      ['with a slash', 'vendor/model'],
      ['with a bracket suffix', 'claude-sonnet-5[1m]'],
      ['starting with a hyphen', '-claude'],
      ['of one character', 'c'],
      ['of 65 characters', 'c'.repeat(65)],
      ['empty', ''],
    ] as const).map(([what, modelHint]) => refused(`model hint ${what}`, d({ modelHint }), 2, 'bad_payload')),
    refused('model hint is a number', tamper({ payload: (p) => ({ ...p, agent: { ...(p.agent as Obj), model_hint: 5 } }) }), 2, 'bad_payload'),
    ok('model hint of two characters', d({ modelHint: 'c5' })),
    ok('model hint of 64 characters', d({ modelHint: 'c'.repeat(64) })),
    ok('model hint with a dot and digits', d({ modelHint: 'claude-sonnet-5.5' })),
    ok('model hint null, with both connector levels', d({ modelHint: null, connectors: [{ name: 'billing', level: 'required', reason: 'ok' }, { name: 'mail', level: 'recommended', reason: 'ok' }] })),
    ok('model hint key absent', tamper({ payload: (p) => ({ ...p, agent: { display_name: (p.agent as Obj).display_name } }) })),

    // ---- step 3: file set
    refused('an outer file the payload does not list', tamper({ document: (doc) => ({ ...doc, files: { ...(doc.files as Obj), 'skills/x/SKILL.md': '# x\n' } }) }), 3, 'file_set_mismatch'),
    refused('a payload file the outer document lacks', tamper({ document: (doc) => {
      const { 'SOUL.md': _s, ...rest } = doc.files as Obj
      return { ...doc, files: rest }
    } }), 3, 'file_set_mismatch'),
    refused('a duplicated payload path', tamper({ payload: (p) => ({ ...p, files: [...filesOf(p), filesOf(p)[0]] }) }), 3, 'file_set_mismatch'),
    refused('CLAUDE.md missing', d({ files: { 'SOUL.md': DEFAULT_FILES['SOUL.md'] } }), 3, 'missing_required_file', { path: 'CLAUDE.md' }),
    refused('SOUL.md missing', d({ files: { 'CLAUDE.md': DEFAULT_FILES['CLAUDE.md'] } }), 3, 'missing_required_file', { path: 'SOUL.md' }),
    refused('the avatar listed among the files', d({
      files: { ...DEFAULT_FILES, 'avatar.png': 'x' },
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
    }), 3, 'file_set_mismatch'),
    refused('outer avatar null, payload avatar set', d({
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
      tamper: { document: (doc) => ({ ...doc, avatar: null }) },
    }), 3, 'file_set_mismatch'),
    refused('outer avatar set, payload avatar null', tamper({ document: (doc) => ({ ...doc, avatar: { path: 'avatar.png', content_type: 'image/png', base64: makePng().toString('base64') } }) }), 3, 'file_set_mismatch'),
    refused('outer and payload avatar paths differ', d({
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
      tamper: { document: (doc) => ({ ...doc, avatar: { ...(doc.avatar as Obj), path: 'avatar.webp' } }) },
    }), 3, 'file_set_mismatch'),

    // ---- step 4: paths
    refused('a scripts/ path', d({ files: { ...DEFAULT_FILES, 'scripts/run.sh': 'echo hi\n' } }), 4, 'path_not_allowed'),
    refused('a traversal path', d({ files: { ...DEFAULT_FILES, 'skills/../CLAUDE.md': 'x\n' } }), 4, 'path_not_allowed'),
    refused('an uppercase skill name', d({ files: { ...DEFAULT_FILES, 'skills/Billing/SKILL.md': '# b\n' } }), 4, 'path_not_allowed'),
    refused('a reference that is not markdown', d({ files: { ...DEFAULT_FILES, 'skills/b/references/x.txt': 'x\n' } }), 4, 'path_not_allowed'),
    refused('an avatar path that is not allowed', d({ avatar: { path: 'avatar.jpg', contentType: 'image/png', bytes: makePng() } }), 4, 'path_not_allowed'),
    refused('two references differing only in case', d({
      files: { ...DEFAULT_FILES, 'skills/b/SKILL.md': '# b\n', 'skills/b/references/Rates.md': 'a\n', 'skills/b/references/rates.md': 'b\n' },
    }), 4, 'case_collision'),

    // ---- step 5: content
    refused('file content differs, same length', tamper({ document: (doc) => ({ ...doc, files: { ...(doc.files as Obj), 'SOUL.md': 'Calm, precise, BRIEF.\n' } }) }), 5, 'hash_mismatch', { path: 'SOUL.md' }),
    refused('payload size differs from the content', tamper({ payload: (p) => ({ ...p, files: filesOf(p).map((f) => (f.path === 'SOUL.md' ? { ...f, size: Number(f.size) + 1 } : f)) }) }), 5, 'size_mismatch', { path: 'SOUL.md' }),
    refused('a leading BOM', d({ files: { ...DEFAULT_FILES, 'CLAUDE.md': '﻿# Agent\n' } }), 5, 'bad_text', { path: 'CLAUDE.md', line: 1 }),
    refused('a NUL', d({ files: { ...DEFAULT_FILES, 'SOUL.md': 'a\nb\u0000\n' } }), 5, 'bad_text', { path: 'SOUL.md', line: 2 }),
    refused('a CR', d({ files: { ...DEFAULT_FILES, 'SOUL.md': 'a\r\nb\n' } }), 5, 'bad_text', { path: 'SOUL.md', line: 1 }),
    refused('S11: a zero-width space in a reference', d({ files: { ...DEFAULT_FILES, 'skills/b/SKILL.md': '# b\n', 'skills/b/references/r.md': 'x\n\ny​z\n' } }), 5, 'bad_text', { path: 'skills/b/references/r.md', line: 3 }),
    refused('S10: an at sign at a line start in a skill', d({ files: { ...DEFAULT_FILES, 'skills/b/SKILL.md': '# b\n@notes.md\n' } }), 5, 'forbidden_import_token', { path: 'skills/b/SKILL.md', line: 2 }),
    refused('S10: an at sign at a line start in SOUL.md', d({ files: { ...DEFAULT_FILES, 'SOUL.md': 'ok\nok\n@x\n' } }), 5, 'forbidden_import_token', { path: 'SOUL.md', line: 3 }),
    refused('S17: an inline pre-run shape in CLAUDE.md', d({ files: { ...DEFAULT_FILES, 'CLAUDE.md': '# A\n!`ls`\n' } }), 5, 'forbidden_exec_token', { path: 'CLAUDE.md', line: 2 }),
    refused('S17: an inline pre-run shape in a skill', d({ files: { ...DEFAULT_FILES, 'skills/b/SKILL.md': 'run !`date`\n' } }), 5, 'forbidden_exec_token', { path: 'skills/b/SKILL.md', line: 1 }),
    refused('S17: a fenced pre-run shape in a reference', d({ files: { ...DEFAULT_FILES, 'skills/b/SKILL.md': '# b\n', 'skills/b/references/r.md': 'a\n```!\nls\n```\n' } }), 5, 'forbidden_exec_token', { path: 'skills/b/references/r.md', line: 2 }),
    // Frontmatter cases come only from the shared text vector (run inside a delivery in the verify test).

    // ---- step 5: manifest free texts (D10, S18 point 1; provisional codes, N21/b)
    refused('title with a word-initial at sign', d({ title: 'Help @x' }), 5, 'forbidden_import_token', { field: 'title' }),
    refused('description with a zero-width joiner', d({ description: 'Keeps‍ invoices' }), 5, 'bad_text', { field: 'description' }),
    refused('display name with a word-initial at sign', d({ displayName: '@helper' }), 5, 'forbidden_import_token', { field: 'agent.display_name' }),
    refused('display name with a bidi override', d({ displayName: 'help‮er' }), 5, 'bad_text', { field: 'agent.display_name' }),
    refused('connector reason with a word-initial at sign', d({ connectors: [{ name: 'billing', level: 'required', reason: 'see @x' }] }), 5, 'forbidden_import_token', { field: 'connectors[0].reason' }),
    refused('connector reason with a full-width at sign', d({ connectors: [{ name: 'billing', level: 'required', reason: 'see ＠x' }] }), 5, 'bad_text', { field: 'connectors[0].reason' }),
    refused('title with an LF', d({ title: 'Invoice\nhelper' }), 5, 'bad_text', { field: 'title', rule: 'manifest-line-break' }),
    refused('description with an LF', d({ description: 'Keeps\nthe invoices' }), 5, 'bad_text', { field: 'description', rule: 'manifest-line-break' }),
    refused('description with a CR', d({ description: 'Keeps\rthe invoices' }), 5, 'bad_text', { field: 'description', rule: 'manifest-line-break' }),
    refused('display name with an LF', d({ displayName: 'Invoice\nhelper' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-line-break' }),
    refused('display name with a CR', d({ displayName: 'Invoice\rhelper' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-line-break' }),
    refused('connector reason with an LF', d({ connectors: [{ name: 'bb', level: 'required', reason: 'a\nb' }] }), 5, 'bad_text', { field: 'connectors[0].reason', rule: 'manifest-line-break' }),
    refused('second connector reason with a CR', d({ connectors: [{ name: 'aa', level: 'required', reason: 'ok' }, { name: 'bb', level: 'required', reason: 'a\rb' }] }), 5, 'bad_text', { field: 'connectors[1].reason', rule: 'manifest-line-break' }),
    // A lone surrogate reaches a manifest text through a JSON escape, in payload bytes that are well formed
    // (parity review of 8e1f906a6; the reference scanner's invalid-utf16 rule).
    refused('title with a lone high surrogate', d({ title: 'Invoice \ud800 helper' }), 5, 'bad_text', { field: 'title', rule: 'invalid-utf16' }),
    refused('description with a lone low surrogate', d({ description: 'Keeps \udc00 invoices' }), 5, 'bad_text', { field: 'description', rule: 'invalid-utf16' }),
    refused('display name ending in a lone high surrogate', d({ displayName: 'Anna\udbff' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'invalid-utf16' }),
    refused('second connector reason with a reversed surrogate pair', d({ connectors: [{ name: 'aa', level: 'required', reason: 'ok' }, { name: 'bb', level: 'required', reason: 'a\udc00\ud800b' }] }), 5, 'bad_text', { field: 'connectors[1].reason', rule: 'invalid-utf16' }),
    // Contract decision (Mira 78043): 1 to N characters, counted in code points.
    refused('an empty title', d({ title: '' }), 5, 'bad_text', { field: 'title', rule: 'manifest-text-length' }),
    refused('a title of 121 characters', d({ title: 't'.repeat(121) }), 5, 'bad_text', { field: 'title', rule: 'manifest-text-length' }),
    refused('an empty description', d({ description: '' }), 5, 'bad_text', { field: 'description', rule: 'manifest-text-length' }),
    refused('a description of 2001 characters', d({ description: 'd'.repeat(2001) }), 5, 'bad_text', { field: 'description', rule: 'manifest-text-length' }),
    refused('an empty display name', d({ displayName: '' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-text-length' }),
    refused('a display name of 61 characters', d({ displayName: 'n'.repeat(61) }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-text-length' }),
    refused('an empty connector reason', d({ connectors: [{ name: 'bb', level: 'required', reason: '' }] }), 5, 'bad_text', { field: 'connectors[0].reason', rule: 'manifest-text-length' }),
    refused('a second connector reason of 201 characters', d({ connectors: [{ name: 'aa', level: 'required', reason: 'ok' }, { name: 'bb', level: 'required', reason: 'r'.repeat(201) }] }), 5, 'bad_text', { field: 'connectors[1].reason', rule: 'manifest-text-length' }),
    refused('a title of 121 astral characters', d({ title: '\ud83d\ude00'.repeat(121) }), 5, 'bad_text', { field: 'title', rule: 'manifest-text-length' }),
    // The text rules come before the count, so the count never runs on a text that is not well formed.
    refused('a title over its length that also holds a lone surrogate', d({ title: 't'.repeat(121) + '\ud800' }), 5, 'bad_text', { field: 'title', rule: 'invalid-utf16' }),
    // Contract decision (Mira, card comment 32004): white space at either end of a manifest text is refused,
    // nothing is trimmed, and the length counts the text as it stands. The set is the Unicode White_Space property.
    refused('a title starting with a space', d({ title: ' Invoice helper' }), 5, 'bad_text', { field: 'title', rule: 'manifest-edge-whitespace' }),
    refused('a title ending with a space', d({ title: 'Invoice helper ' }), 5, 'bad_text', { field: 'title', rule: 'manifest-edge-whitespace' }),
    refused('a title of spaces only', d({ title: '   ' }), 5, 'bad_text', { field: 'title', rule: 'manifest-edge-whitespace' }),
    refused('a description starting with a no-break space', d({ description: ' Keeps the invoices' }), 5, 'bad_text', { field: 'description', rule: 'manifest-edge-whitespace' }),
    refused('a description ending with an ideographic space', d({ description: 'Keeps the invoices　' }), 5, 'bad_text', { field: 'description', rule: 'manifest-edge-whitespace' }),
    refused('a display name starting with a tab', d({ displayName: '\tAnna' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-edge-whitespace' }),
    refused('a display name ending with a narrow no-break space', d({ displayName: 'Anna ' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-edge-whitespace' }),
    refused('a display name of one ideographic space', d({ displayName: '　' }), 5, 'bad_text', { field: 'agent.display_name', rule: 'manifest-edge-whitespace' }),
    refused('a connector reason starting with an en quad', d({ connectors: [{ name: 'bb', level: 'required', reason: ' Reads mail.' }] }), 5, 'bad_text', { field: 'connectors[0].reason', rule: 'manifest-edge-whitespace' }),
    refused('a second connector reason ending with a medium mathematical space', d({ connectors: [{ name: 'aa', level: 'required', reason: 'ok' }, { name: 'bb', level: 'required', reason: 'Reads mail. ' }] }), 5, 'bad_text', { field: 'connectors[1].reason', rule: 'manifest-edge-whitespace' }),
    // An end that an earlier rule refuses anywhere in the text keeps that rule: these cases pin which one.
    refused('a title ending with a line separator: S11 refuses it anywhere', d({ title: 'Invoice helper ' }), 5, 'bad_text', { field: 'title', rule: 'forbidden-char' }),
    refused('a title starting with U+0085, white space by the property: S11 refuses it anywhere', d({ title: '\u0085Invoice helper' }), 5, 'bad_text', { field: 'title', rule: 'forbidden-char' }),
    refused('a title ending with U+FEFF, not white space by the property: S11 refuses it anywhere', d({ title: 'Invoice helper﻿' }), 5, 'bad_text', { field: 'title', rule: 'forbidden-char' }),
    refused('a title ending with an LF', d({ title: 'Invoice helper\n' }), 5, 'bad_text', { field: 'title', rule: 'manifest-line-break' }),
    // The length is counted on the text as it stands, and before the two ends are looked at.
    refused('a title of 121 characters, the last one a space', d({ title: 't'.repeat(120) + ' ' }), 5, 'bad_text', { field: 'title', rule: 'manifest-text-length' }),
    refused('a title of 120 characters, the last one a space', d({ title: 't'.repeat(119) + ' ' }), 5, 'bad_text', { field: 'title', rule: 'manifest-edge-whitespace' }),
    ok('manifest texts with white space inside, none at an end', d({
      title: 'Invoice helper', description: 'Keeps　the\tinvoices', displayName: 'Anna B', connectors: [{ name: 'bb', level: 'required', reason: 'Reads the  mail.' }],
    })),
    ok('manifest texts of one character each', d({ title: 't', description: 'd', displayName: 'n', connectors: [{ name: 'bb', level: 'required', reason: 'r' }] })),
    ok('manifest texts at their upper bounds', d({
      title: 't'.repeat(120), description: 'd'.repeat(2000), displayName: 'n'.repeat(60), connectors: [{ name: 'bb', level: 'required', reason: 'r'.repeat(200) }],
    })),
    ok('a title of 120 astral characters (240 UTF-16 units)', d({ title: '\ud83d\ude00'.repeat(120) })),
    ok('manifest texts with a well-formed surrogate pair', d({
      title: 'Invoice helper 😀', description: 'Keeps 😀 invoices', displayName: 'Anna 😀', connectors: [{ name: 'bb', level: 'required', reason: 'Reads 😀 mail.' }],
    })),
    ok('manifest texts with an e-mail shape and a bang at a sentence end', d({
      title: 'Invoice helper!', description: 'Write to anna1@example.com.', displayName: 'Anna', connectors: [{ name: 'bb', level: 'required', reason: 'Reads mail.' }],
    })),

    // ---- step 5: avatar
    refused('avatar base64 is not base64', d({
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
      tamper: { document: (doc) => ({ ...doc, avatar: { ...(doc.avatar as Obj), base64: '***' } }) },
    }), 5, 'bad_avatar', { path: 'avatar.png', rule: 'base64' }),
    refused('avatar bytes differ', d({
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
      tamper: { document: (doc) => ({ ...doc, avatar: { ...(doc.avatar as Obj), base64: makePng([pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT', new Uint8Array([1, 2, 3, 4])), pngChunk('IEND')]).toString('base64') } }) },
    }), 5, 'hash_mismatch', { path: 'avatar.png' }),
    refused('avatar size differs', d({
      avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng() },
      tamper: { payload: (p) => ({ ...p, avatar: { ...(p.avatar as Obj), size: 1 } }) },
    }), 5, 'size_mismatch', { path: 'avatar.png' }),
    refused('content_type does not match the extension', d({ avatar: { path: 'avatar.png', contentType: 'image/webp', bytes: makePng() } }), 5, 'bad_avatar', { path: 'avatar.png', rule: 'content-type' }),
    refused('PNG name and type, WebP bytes', d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makeWebp() } }), 5, 'bad_avatar', { path: 'avatar.png', rule: 'content-type' }),
    refused('WebP name and type, PNG bytes', d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: makePng() } }), 5, 'bad_avatar', { path: 'avatar.webp', rule: 'content-type' }),
    // The avatar blocks are an allowlist (contract decision, Mira 77967). The first four PNG types and the first
    // two WebP types are the old denylist; the rest passed it (measured in the review of d021f7f2b).
    ...(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'teXt', 'prVt', 'iCCP', 'tIME', 'sPLT', 'zzzz', 'ihdr', 'idat', 'IDAt', 'gAMA', 'pHYs'] as const).map((type) =>
      refused(`PNG with a ${type} block`, d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng([
        pngChunk('IHDR', new Uint8Array(13)), pngChunk(type, new Uint8Array(Buffer.from('k\u0000v'))), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND'),
      ]) } }), 5, 'bad_avatar', { path: 'avatar.png', rule: 'block-not-allowed' })),
    ...(['EXIF', 'XMP ', 'xmp ', 'ICCP', 'TEXT', 'ANIM', 'ANMF', 'vp8l', 'VP8', 'zzzz'] as const).map((fourcc) =>
      refused(`WebP with a "${fourcc}" block`, d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: makeWebp([
        webpChunk('VP8X', new Uint8Array(10)), webpChunk('VP8L', new Uint8Array(6)), webpChunk(fourcc, new Uint8Array(5)),
      ]) } }), 5, 'bad_avatar', { path: 'avatar.webp', rule: 'block-not-allowed' })),
    // PNG order: IHDR first and once, at least one IDAT, IEND last and once.
    ...([
      ['without IHDR', ['IDAT', 'IEND']],
      ['without IDAT', ['IHDR', 'IEND']],
      ['without IEND', ['IHDR', 'IDAT']],
      ['with no block at all', []],
      ['with IHDR after another block', ['PLTE', 'IHDR', 'IDAT', 'IEND']],
      ['with a second IHDR', ['IHDR', 'IDAT', 'IHDR', 'IEND']],
      ['with a block after IEND', ['IHDR', 'IDAT', 'IEND', 'IDAT']],
      ['with a second IEND', ['IHDR', 'IDAT', 'IEND', 'IEND']],
      // Contract decision (Mira 78020): PLTE and tRNS at most once.
      ['with a second PLTE', ['IHDR', 'PLTE', 'PLTE', 'IDAT', 'IEND']],
      ['with a second tRNS', ['IHDR', 'PLTE', 'tRNS', 'tRNS', 'IDAT', 'IEND']],
      // Contract decision (Mira 78043): PLTE and tRNS before the first IDAT.
      ['with PLTE after the first IDAT', ['IHDR', 'IDAT', 'PLTE', 'IEND']],
      ['with tRNS after the first IDAT', ['IHDR', 'PLTE', 'IDAT', 'tRNS', 'IEND']],
      ['with PLTE between two IDAT blocks', ['IHDR', 'IDAT', 'PLTE', 'IDAT', 'IEND']],
    ] as const).map(([what, types]) =>
      refused(`PNG ${what}`, d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng(types.map((t) => pngChunk(t, new Uint8Array(t === 'IHDR' ? 13 : t === 'IEND' ? 0 : 4)))) } }),
        5, 'bad_avatar', { path: 'avatar.png', rule: 'block-structure' })),
    ok('PNG with a palette, transparency and two IDAT blocks', d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng([
      pngChunk('IHDR', new Uint8Array(13)), pngChunk('PLTE', new Uint8Array(6)), pngChunk('tRNS', new Uint8Array(2)),
      pngChunk('IDAT', new Uint8Array(4)), pngChunk('IDAT', new Uint8Array(3)), pngChunk('IEND'),
    ]) } })),
    // WebP order: one of the six layouts.
    ...([
      ['simple lossy', ['VP8 ']],
      ['extended lossy', ['VP8X', 'VP8 ']],
      ['extended lossless', ['VP8X', 'VP8L']],
      ['extended lossy with alpha', ['VP8X', 'ALPH', 'VP8 ']],
      ['extended lossless with alpha', ['VP8X', 'ALPH', 'VP8L']],
    ] as const).map(([what, fourccs]) =>
      ok(`WebP ${what}`, d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: makeWebp(fourccs.map((f) => webpChunk(f, new Uint8Array(f === 'VP8X' ? 10 : 5)))) } }))),
    ...([
      ['with no block at all', []],
      ['with VP8X alone', ['VP8X']],
      ['with VP8X and alpha but no image', ['VP8X', 'ALPH']],
      ['with alpha but no VP8X', ['ALPH', 'VP8 ']],
      ['with two images', ['VP8L', 'VP8L']],
      ['with VP8X after the image', ['VP8L', 'VP8X']],
      ['with alpha after the image', ['VP8X', 'VP8 ', 'ALPH']],
      ['with a second VP8X', ['VP8X', 'VP8X', 'VP8L']],
    ] as const).map(([what, fourccs]) =>
      refused(`WebP ${what}`, d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: makeWebp(fourccs.map((f) => webpChunk(f, new Uint8Array(f === 'VP8X' ? 10 : 5)))) } }),
        5, 'bad_avatar', { path: 'avatar.webp', rule: 'block-structure' })),
    // Contract decision (Mira 78043): IHDR is 13 bytes, IEND is empty, the RIFF size is the byte length minus 8.
    ...([
      ['an IHDR of 12 bytes', [pngChunk('IHDR', new Uint8Array(12)), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND')]],
      ['an IHDR of 14 bytes', [pngChunk('IHDR', new Uint8Array(14)), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND')]],
      ['an IHDR of 0 bytes', [pngChunk('IHDR'), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND')]],
      ['an IEND that carries one byte', [pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND', new Uint8Array(1))]],
      ['an IEND that carries a text', [pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND', new Uint8Array(Buffer.from('hidden note')))]],
    ] as Array<[string, Buffer[]]>).map(([what, chunks]) =>
      refused(`PNG with ${what}`, d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: makePng(chunks) } }),
        5, 'bad_avatar', { path: 'avatar.png', rule: 'block-structure' })),
    refused('WebP RIFF size two bytes short of the end', d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: riffSizeShort(2) } }), 5, 'bad_avatar', { path: 'avatar.webp', rule: 'block-structure' }),
    refused('WebP with a whole allowed chunk after the RIFF end', d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: chunkAfterRiffEnd() } }), 5, 'bad_avatar', { path: 'avatar.webp', rule: 'block-structure' }),
    refused('PNG block length past the end', d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: truncatedPng() } }), 5, 'bad_avatar', { path: 'avatar.png', rule: 'truncated-block' }),
    refused('PNG with a partial block header at the end', d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: Buffer.concat([makePng(), Buffer.from([0, 0, 0])]) } }), 5, 'bad_avatar', { path: 'avatar.png', rule: 'truncated-block' }),
    refused('WebP chunk length past the end', d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: truncatedWebpChunk() } }), 5, 'bad_avatar', { path: 'avatar.webp', rule: 'truncated-block' }),
    refused('WebP RIFF size past the end', d({ avatar: { path: 'avatar.webp', contentType: 'image/webp', bytes: riffSizePastEnd() } }), 5, 'bad_avatar', { path: 'avatar.webp', rule: 'truncated-block' }),

    // ---- step 6: limits
    refused('65 text files', d({ files: manyFiles(65) }), 6, 'limit_exceeded', { limit: 'file_count' }),
    refused('more than 1 MiB of text in total', d({ files: { ...DEFAULT_FILES, ...bigFiles(4, 256 * 1024) } }), 6, 'limit_exceeded', { limit: 'total_text_bytes' }),
    refused('a text file over 256 KiB', d({ files: { ...DEFAULT_FILES, 'skills/big/SKILL.md': 'a'.repeat(256 * 1024 + 1) } }), 6, 'limit_exceeded', { limit: 'text_file_bytes', path: 'skills/big/SKILL.md' }),
    refused('an avatar over 512 KiB', d({ avatar: { path: 'avatar.png', contentType: 'image/png', bytes: pngOfSize(512 * 1024 + 1) } }), 6, 'limit_exceeded', { limit: 'avatar_bytes', path: 'avatar.png' }),

    // ---- the first failure stops
    refused('slug mismatch AND a scripts/ path: step 2 wins', d({ slug: 'other-agent', files: { ...DEFAULT_FILES, 'scripts/x.sh': 'x\n' } }), 2, 'slug_mismatch'),
    refused('missing SOUL.md AND a bad path: step 3 wins', d({ files: { 'CLAUDE.md': '# a\n', 'scripts/x.sh': 'x\n' } }), 3, 'missing_required_file', { path: 'SOUL.md' }),
    refused('a bad path AND a BOM: step 4 wins', d({ files: { ...DEFAULT_FILES, 'CLAUDE.md': '﻿x\n', 'scripts/x.sh': 'x\n' } }), 4, 'path_not_allowed'),
    refused('a BOM AND 65 files: step 5 wins', d({ files: { ...manyFiles(65), 'CLAUDE.md': '﻿x\n' } }), 5, 'bad_text', { path: 'CLAUDE.md', line: 1 }),
  ]
  return { keys, signer, cases }
}

/** CLAUDE.md, SOUL.md and skills up to `count` text files in total. */
export function manyFiles(count: number): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_FILES }
  for (let i = 0; Object.keys(out).length < count; i++) out[`skills/s${i}/SKILL.md`] = `# s${i}\n`
  return out
}

function bigFiles(count: number, size: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) out[`skills/big${i}/SKILL.md`] = 'a'.repeat(size)
  return out
}

/** A metadata-free PNG of exactly `size` bytes (one padded IDAT). */
function pngOfSize(size: number): Buffer {
  const fixed = makePng([pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT'), pngChunk('IEND')]).length
  return makePng([pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT', new Uint8Array(size - fixed)), pngChunk('IEND')])
}

function truncatedPng(): Buffer {
  const idat = pngChunk('IDAT', new Uint8Array(4))
  idat.writeUInt32BE(400, 0)
  return makePng([pngChunk('IHDR', new Uint8Array(13)), idat])
}

function truncatedWebpChunk(): Buffer {
  const chunk = webpChunk('VP8L', new Uint8Array(6))
  chunk.writeUInt32LE(600, 4)
  return makeWebp([chunk])
}

/** A valid one-chunk WebP whose RIFF size field says `by` bytes fewer than there are. */
function riffSizeShort(by: number): Buffer {
  const b = makeWebp()
  b.writeUInt32LE(b.length - 8 - by, 4)
  return b
}

/** VP8X inside the RIFF size, and the image chunk after it: every chunk allowed, the layout allowed, the size not the length. */
function chunkAfterRiffEnd(): Buffer {
  const first = webpChunk('VP8X', new Uint8Array(10))
  const b = makeWebp([first, webpChunk('VP8L', new Uint8Array(6))])
  b.writeUInt32LE(4 + first.length, 4)
  return b
}

function riffSizePastEnd(): Buffer {
  const b = makeWebp()
  b.writeUInt32LE(b.length, 4)
  return b
}
