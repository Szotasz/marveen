import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatGroupRecord,
  parseGroupRecord,
  readGroupRecord,
  removeGroupRecord,
  writeGroupRecord,
  GroupRecordError,
  GROUP_RECORD_MAX_BYTES,
  SUPPORT_GROUP_RECORD_FILE,
  SUPPORT_RUN_DIR,
  SUPPORT_SPOOL_DIR,
  type SupportGroupRecord,
} from '../support-group-record.js'
import { SUPPORT_TOKEN_FILE } from '../support-access-token.js'

// TEST ONLY values: a uuid, fingerprints and documentation addresses issued by nobody.
const FP1 = 'SHA256:' + 'A'.repeat(43)
const FP2 = 'SHA256:' + 'b'.repeat(42) + '+'
const RECORD: SupportGroupRecord = {
  grantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  consentVersion: 1,
  consentAt: '2026-11-15T06:10:00Z',
  keys: [
    { name: 'key1', fingerprint: FP1 },
    { name: 'key2', fingerprint: FP2 },
  ],
  fromCidrs: ['203.0.113.7/32', '2001:db8::7/128'],
  dispatchPath: '/home/marveen/.marveen/support/kit/support-dispatch.sh',
  sshd: { major: 9, minor: 6 },
}
const TEXT =
  'marveen-support-group 1\n' +
  'grant-id 3f2504e0-4f89-41d3-9a0c-0305e82c3301\n' +
  'consent 1\n' +
  'consent-at 2026-11-15T06:10:00Z\n' +
  'key key1 ' + FP1 + '\n' +
  'key key2 ' + FP2 + '\n' +
  'from 203.0.113.7/32\n' +
  'from 2001:db8::7/128\n' +
  'dispatch /home/marveen/.marveen/support/kit/support-dispatch.sh\n' +
  'sshd 9.6\n'

describe('the group record text', () => {
  it('is one fact per line and reads back as what was written', () => {
    expect(formatGroupRecord(RECORD)).toBe(TEXT)
    expect(parseGroupRecord(TEXT)).toEqual(RECORD)
  })

  it('names its file in the token\'s pattern, and the spool and the run folder too (Geri 78364)', () => {
    expect([SUPPORT_TOKEN_FILE, SUPPORT_GROUP_RECORD_FILE, SUPPORT_SPOOL_DIR, SUPPORT_RUN_DIR]).toEqual([
      'support-access.token',
      'support-access.group',
      'support-access.spool',
      'support-access.run',
    ])
  })

  it.each<[string, Partial<SupportGroupRecord>]>([
    ['a grant id that is not a uuid', { grantId: 'abc' }],
    ['a consent version of zero', { consentVersion: 0 }],
    ['a consent version that is not whole', { consentVersion: 1.5 }],
    ['a consent time with an offset', { consentAt: '2026-11-15T07:10:00+01:00' }],
    ['a consent time with milliseconds', { consentAt: '2026-11-15T06:10:00.123Z' }],
    ['no key', { keys: [] }],
    ['three keys', { keys: [...RECORD.keys, { name: 'key3', fingerprint: FP1 }] }],
    ['keys out of name order', { keys: [RECORD.keys[1], RECORD.keys[0]] }],
    ['the same key name twice', { keys: [RECORD.keys[0], RECORD.keys[0]] }],
    ['a key name in upper case', { keys: [{ name: 'Key1', fingerprint: FP1 }] }],
    ['a short fingerprint', { keys: [{ name: 'key1', fingerprint: 'SHA256:abc' }] }],
    ['no source', { fromCidrs: [] }],
    ['a network instead of a host', { fromCidrs: ['203.0.113.0/24'] }],
    ['a dispatcher path with a space', { dispatchPath: '/home/a b/support-dispatch.sh' }],
    ['a relative dispatcher path', { dispatchPath: 'kit/support-dispatch.sh' }],
    ['an sshd version that is not one', { sshd: { major: 0, minor: 1 } }],
  ])('refuses to write %s', (_label, over) => {
    let code: unknown = null
    try {
      formatGroupRecord({ ...RECORD, ...over })
    } catch (err) {
      code = err instanceof GroupRecordError ? err.code : err
    }
    expect(code).toBe('group_record_invalid')
  })

  it.each<[string, string]>([
    ['nothing', ''],
    ['another header', TEXT.replace('marveen-support-group 1', 'marveen-support-group 2')],
    ['no final line end', TEXT.slice(0, -1)],
    ['CR LF line ends', TEXT.replace(/\n/g, '\r\n')],
    ['a repeated grant id', TEXT + 'grant-id 3f2504e0-4f89-41d3-9a0c-0305e82c3301\n'],
    ['an unknown key', TEXT + 'token x\n'],
    ['a missing sshd line', TEXT.replace('sshd 9.6\n', '')],
    ['the facts out of order', TEXT.replace(/(consent 1\n)(consent-at [^\n]*\n)/, '$2$1')],
    ['a consent with a leading zero', TEXT.replace('consent 1\n', 'consent 01\n')],
    ['an sshd version with three parts', TEXT.replace('sshd 9.6', 'sshd 9.6.1')],
    ['two spaces', TEXT.replace('consent 1', 'consent  1')],
    ['more than the cap', TEXT + 'x'.repeat(GROUP_RECORD_MAX_BYTES)],
  ])('does not read %s as a record', (_label, text) => {
    expect(parseGroupRecord(text)).toBeNull()
  })

  it('reads a canonical record up to the cap, and not one byte past it', () => {
    const withPath = (length: number): SupportGroupRecord => ({ ...RECORD, dispatchPath: '/' + 'p'.repeat(length - 1) })
    const room = GROUP_RECORD_MAX_BYTES - (TEXT.length - RECORD.dispatchPath.length)
    const atCap = formatGroupRecord(withPath(room))
    expect(atCap.length).toBe(GROUP_RECORD_MAX_BYTES)
    expect(parseGroupRecord(atCap)).toEqual(withPath(room))
    const pastCap = formatGroupRecord(withPath(room + 1))
    expect(pastCap.length).toBe(GROUP_RECORD_MAX_BYTES + 1)
    expect(parseGroupRecord(pastCap)).toBeNull()
  })
})

describe('the group record on disk', () => {
  let root: string
  let dir: string
  const file = (): string => join(dir, SUPPORT_GROUP_RECORD_FILE)
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'support-group-')))
    dir = join(root, 'support')
    mkdirSync(dir, { mode: 0o700 })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes one 0600 file, reads it back, and leaves no temporary file', () => {
    writeGroupRecord(dir, RECORD)
    expect(readFileSync(file(), 'utf8')).toBe(TEXT)
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readGroupRecord(dir)).toEqual({ kind: 'ok', record: RECORD })
    expect(readdirSync(dir)).toEqual([SUPPORT_GROUP_RECORD_FILE])
    writeGroupRecord(dir, { ...RECORD, consentVersion: 2 })
    expect(readGroupRecord(dir)).toMatchObject({ kind: 'ok', record: { consentVersion: 2 } })
  })

  it.each<[string, number]>([
    ['zero', 0],
    ['one that would leave the owner write-only', 0o477],
  ])('writes the file 0600 and reads it back under a umask of %s', (_label, mask) => {
    const saved = process.umask(mask)
    try {
      writeGroupRecord(dir, RECORD)
    } finally {
      process.umask(saved)
    }
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readGroupRecord(dir)).toEqual({ kind: 'ok', record: RECORD })
  })

  it('says missing when there is no record or no folder', () => {
    expect(readGroupRecord(dir)).toEqual({ kind: 'missing' })
    expect(readGroupRecord(join(root, 'nope'))).toEqual({ kind: 'missing' })
  })

  it('does NOT use a record that is a link, readable by others, garbled, or in an unsafe folder', () => {
    writeGroupRecord(dir, RECORD)
    chmodSync(file(), 0o644)
    expect(readGroupRecord(dir)).toEqual({ kind: 'invalid' })
    chmodSync(file(), 0o600)
    writeFileSync(file(), TEXT.replace('consent 1', 'consent one'), { mode: 0o600 })
    expect(readGroupRecord(dir)).toEqual({ kind: 'invalid' })
    rmSync(file())
    writeFileSync(join(root, 'elsewhere'), TEXT, { mode: 0o600 })
    symlinkSync(join(root, 'elsewhere'), file())
    expect(readGroupRecord(dir)).toEqual({ kind: 'invalid' })
    rmSync(file())
    writeGroupRecord(dir, RECORD)
    chmodSync(dir, 0o770)
    expect(readGroupRecord(dir)).toEqual({ kind: 'invalid' })
    chmodSync(dir, 0o700)
  })

  it('refuses to write into an unsafe folder or over something that is not a file', () => {
    chmodSync(dir, 0o707)
    expect(() => writeGroupRecord(dir, RECORD)).toThrow(expect.objectContaining({ code: 'group_dir_unsafe' }))
    chmodSync(dir, 0o700)
    expect(readdirSync(dir)).toEqual([])
    expect(() => writeGroupRecord(join(root, 'nope'), RECORD)).toThrow(expect.objectContaining({ code: 'group_dir_unsafe' }))
    mkdirSync(file())
    expect(() => writeGroupRecord(dir, RECORD)).toThrow(expect.objectContaining({ code: 'group_record_unsafe' }))
    rmSync(file(), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), file())
    expect(() => writeGroupRecord(dir, RECORD)).toThrow(expect.objectContaining({ code: 'group_record_unsafe' }))
    expect(existsSync(join(root, 'elsewhere'))).toBe(false)
  })

  it('removes the record, a link as a link, and is idempotent', () => {
    writeGroupRecord(dir, RECORD)
    expect(removeGroupRecord(dir)).toBe(true)
    expect(removeGroupRecord(dir)).toBe(false)
    writeFileSync(join(root, 'target'), 'keep\n')
    symlinkSync(join(root, 'target'), file())
    expect(removeGroupRecord(dir)).toBe(true)
    expect(lstatSync(join(root, 'target')).isFile()).toBe(true)
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('keep\n')
  })
})
