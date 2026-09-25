// Caller evidence for owner WRITE commands (#1530 review). The rule: the
// Telegram message must be on record in the channel plugin's own inbound log
// -- the owner's chat, the same message id, the same text, recent, and not
// used before.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWriteEvidence, findEvidence, readEvidenceLines, EVIDENCE_FILE, EVIDENCE_WINDOW_MS } from '../web/write-evidence.js'

const NOW = 1_780_000_000_000
const line = (o: Record<string, unknown>) => JSON.stringify({ chat_id: '42', message_id: '901', text: '/model opus', at: NOW - 5_000, ...o })

function check(lines: string[], req: Partial<{ chatId: string; messageId: string | null; text: string; now: number }> = {}, claimed = new Set<string>()) {
  return checkWriteEvidence(
    { chatId: '42', messageId: '901', text: '/model opus', now: NOW, ...req },
    () => lines,
    (c, m) => { const k = `${c}:${m}`; if (claimed.has(k)) return false; claimed.add(k); return true },
  )
}

let dirs: string[] = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

describe('checkWriteEvidence', () => {
  it('a recorded message from the owner chat, same text, recent: ok', () => {
    expect(check([line({})])).toEqual({ ok: true })
  })
  it('no message id at all (an HTTP caller that names none): refused', () => {
    expect(check([line({})], { messageId: null })).toEqual({ ok: false, reason: 'no-message-id' })
  })
  it('a message id the plugin never recorded: refused', () => {
    expect(check([line({})], { messageId: '902' })).toEqual({ ok: false, reason: 'not-found' })
  })
  it('the same message id from another chat does not count', () => {
    expect(check([line({ chat_id: '43' })])).toEqual({ ok: false, reason: 'not-found' })
  })
  it('a different text under a real message id (an agent reusing the owner\'s id): refused', () => {
    expect(check([line({ text: 'szia' })], { text: '/model opus' })).toEqual({ ok: false, reason: 'text-mismatch' })
  })
  it('entities Claude Code puts in the <channel> body still match the plain logged text', () => {
    expect(check([line({ text: '/model opus <x> & "y"' })], { text: '/model opus &lt;x&gt; &amp; &quot;y&quot;' })).toEqual({ ok: true })
  })
  it('older than the window: refused (too-old); a record from the future is refused too', () => {
    expect(check([line({ at: NOW - EVIDENCE_WINDOW_MS - 1 })])).toEqual({ ok: false, reason: 'too-old' })
    expect(check([line({ at: NOW + 5 * 60_000 })])).toEqual({ ok: false, reason: 'too-old' })
    expect(check([line({ at: NOW - EVIDENCE_WINDOW_MS + 1_000 })])).toEqual({ ok: true })
  })
  it('single use: the second claim of the same message is refused', () => {
    const claimed = new Set<string>()
    expect(check([line({})], {}, claimed)).toEqual({ ok: true })
    expect(check([line({})], {}, claimed)).toEqual({ ok: false, reason: 'already-used' })
  })
  it('a refused check does not use the message up', () => {
    const claimed = new Set<string>()
    expect(check([line({})], { text: 'mas' }, claimed).ok).toBe(false)
    expect(check([line({})], {}, claimed)).toEqual({ ok: true })
  })
  it('malformed lines and records without text/at are skipped', () => {
    expect(check(['{nope 901', JSON.stringify({ chat_id: '42', message_id: '901' }), ''])).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('findEvidence / readEvidenceLines', () => {
  it('reads the rotated file too (a message logged just before the rotation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-evidence-')); dirs.push(dir)
    writeFileSync(join(dir, `${EVIDENCE_FILE}.1`), line({}) + '\n')
    writeFileSync(join(dir, EVIDENCE_FILE), line({ message_id: '950' }) + '\n')
    const lines = readEvidenceLines(dir)
    expect(findEvidence(lines, '42', '901')?.text).toBe('/model opus')
    expect(findEvidence(lines, '42', '950')).not.toBeNull()
  })
  it('no log at all (the plugin patch is missing): nothing found, so no write runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-evidence-')); dirs.push(dir)
    expect(readEvidenceLines(dir)).toEqual([])
  })
})
