import { describe, it, expect } from 'vitest'
import {
  buildSupportLine,
  buildSupportGrantLines,
  splitAuthorizedKeysLine,
  isSupportLine,
  holdsPinnedKey,
  removeSupportLines,
  countSupportLines,
  mergeSupportLines,
  reconcileSupportLines,
  supportLineComment,
  sshdAtLeast,
  SupportLineError,
  SUPPORT_COMMENT_PREFIX,
  SUPPORT_MIN_SSHD,
  type SupportGrantInput,
  type SupportLineInput,
} from '../support-access-line.js'
import { fingerprintOfBlob } from '../support-access-pins.js'
import {
  skBlob,
  TEST_ONLY_KEYS,
  TEST_ONLY_BLOBS,
  TEST_ONLY_BLOB_1,
  TEST_ONLY_FROM,
  TEST_ONLY_FROM_V6,
} from './helpers/sk-test-keys.js'

const GRANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const OTHER_GRANT = '9b2e7c1a-5d44-4e0b-8f3a-6c1d2e3f4a5b'
const DISPATCH = '/opt/marveen/scripts/support-dispatch.sh'

function input(over: Partial<SupportLineInput> = {}): SupportLineInput {
  return {
    key: TEST_ONLY_KEYS[0],
    grantId: GRANT,
    consentVersion: 1,
    dispatchPath: DISPATCH,
    fromCidrs: TEST_ONLY_FROM,
    sshd: { major: 9, minor: 6 },
    ...over,
  }
}

const FOREIGN_TAIL = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ intruder'

function grantInput(over: Partial<SupportGrantInput> = {}): SupportGrantInput {
  return {
    keys: TEST_ONLY_KEYS,
    fromCidrs: TEST_ONLY_FROM,
    grantId: GRANT,
    consentVersion: 1,
    dispatchPath: DISPATCH,
    sshd: { major: 9, minor: 6 },
    ...over,
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof SupportLineError) return err.code
    throw err
  }
  return 'no error'
}

/**
 * Every authorized_keys option that hands a capability back after `restrict`,
 * or widens who may log in. None of them may ever stand in a support line.
 */
const GIVES_BACK = [
  'no-touch-required',
  'pty',
  'port-forwarding',
  'agent-forwarding',
  'X11-forwarding',
  'user-rc',
  'permitopen="localhost:5900"',
  'permitlisten="localhost:5900"',
  'tunnel="0"',
  'environment="PATH=/tmp"',
  'cert-authority',
]

/** The options field of a built line, split on the commas that are outside quotes. */
function optionList(line: string): string[] {
  const options = splitAuthorizedKeysLine(line)?.options ?? ''
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const c of options) {
    if (c === '"') quoted = !quoted
    if (c === ',' && !quoted) {
      out.push(current)
      current = ''
    } else current += c
  }
  out.push(current)
  return out
}

describe('buildSupportLine', () => {
  it('builds exactly this line (golden)', () => {
    expect(buildSupportLine(input())).toBe(
      'restrict,command="/bin/sh /opt/marveen/scripts/support-dispatch.sh --key key1 --fp ' +
        TEST_ONLY_KEYS[0].fingerprint +
        ' --grant ' +
        GRANT +
        ' --consent 1",from="203.0.113.7/32",verify-required ' +
        'sk-ssh-ed25519@openssh.com ' +
        TEST_ONLY_BLOB_1 +
        ' marveen-support:' +
        GRANT +
        ':key1',
    )
  })

  it('THE OPTION LIST IS CLOSED: exactly these four options, in this order, for one source or two', () => {
    for (const fromCidrs of [TEST_ONLY_FROM, ['203.0.113.7/32', TEST_ONLY_FROM_V6]]) {
      const names = optionList(buildSupportLine(input({ fromCidrs }))).map((o) => o.split('=')[0])
      expect(names).toEqual(['restrict', 'command', 'from', 'verify-required'])
    }
  })

  it.each(GIVES_BACK.map((o) => o.split('=')[0]).concat('expiry-time'))('never carries %s', (forbidden) => {
    for (const sshd of [{ major: 8, minor: 4 }, { major: 9, minor: 6 }, { major: 10, minor: 2 }]) {
      const names = optionList(buildSupportLine(input({ sshd }))).map((o) => o.split('=')[0])
      expect(names).not.toContain(forbidden)
    }
  })

  it('has ONE shape on every supported sshd: no expiry, no version-dependent part', () => {
    const lines = [{ major: 8, minor: 4 }, { major: 8, minor: 9 }, { major: 9, minor: 2 }, { major: 10, minor: 2 }].map((sshd) =>
      buildSupportLine(input({ sshd })),
    )
    expect(new Set(lines).size).toBe(1)
    expect(lines[0]).not.toContain('expiry')
  })

  it('binds the key name of ITS OWN key into the command and the comment', () => {
    const line1 = buildSupportLine(input({ key: TEST_ONLY_KEYS[0] }))
    const line2 = buildSupportLine(input({ key: TEST_ONLY_KEYS[1] }))
    expect(line1).toContain('--key key1 --fp ' + TEST_ONLY_KEYS[0].fingerprint + ' --grant ')
    expect(line2).toContain('--key key2 --fp ' + TEST_ONLY_KEYS[1].fingerprint + ' --grant ')
    expect(line2).not.toContain(TEST_ONLY_KEYS[0].fingerprint)
    expect(line1).toContain('--key key1 ')
    expect(line1.endsWith(':key1')).toBe(true)
    expect(line1).toContain(' ' + TEST_ONLY_KEYS[0].pub + ' ')
    expect(line2).toContain('--key key2 ')
    expect(line2.endsWith(':key2')).toBe(true)
    expect(line2).toContain(' ' + TEST_ONLY_KEYS[1].pub + ' ')
    expect(line2).not.toContain(TEST_ONLY_KEYS[0].pub)
  })

  it('writes the fingerprint of the BLOB, whatever the pin record claims', () => {
    // The builder does not re-check a pin's stated fingerprint (validateSupportPins does);
    // it must still never put a fingerprint into the command that is not its own key's.
    const lying = { ...TEST_ONLY_KEYS[0], fingerprint: TEST_ONLY_KEYS[1].fingerprint }
    const line = buildSupportLine(input({ key: lying }))
    expect(line).toContain(' --fp ' + TEST_ONLY_KEYS[0].fingerprint + ' ')
    expect(line).not.toContain(TEST_ONLY_KEYS[1].fingerprint)
  })

  it('the fingerprint in the command is SHA256: and 43 base64 characters, safe inside the quoted command', () => {
    const command = /command="([^"]*)"/.exec(buildSupportLine(input()))?.[1] ?? ''
    expect(command).toMatch(/ --fp SHA256:[A-Za-z0-9+/]{43} --grant /)
    expect(command).toMatch(/^[A-Za-z0-9 ._/:+-]+$/)
  })

  it('carries the grant id and the consent version in the command', () => {
    const line = buildSupportLine(input({ consentVersion: 7 }))
    expect(line).toContain('--grant ' + GRANT + ' --consent 7"')
  })

  it('writes two sources as one from list, and accepts an IPv6 host', () => {
    const line = buildSupportLine(input({ fromCidrs: ['203.0.113.7/32', TEST_ONLY_FROM_V6] }))
    expect(line).toContain('from="203.0.113.7/32,2001:db8::7/128"')
  })

  it('reads back through the splitter as one sk key with the whole options field', () => {
    const line = buildSupportLine(input())
    const fields = splitAuthorizedKeysLine(line)
    expect(fields?.keyType).toBe('sk-ssh-ed25519@openssh.com')
    expect(fields?.blob).toBe(TEST_ONLY_BLOB_1)
    expect(fields?.comment).toBe(supportLineComment(GRANT, 'key1'))
    expect(fields?.options?.startsWith('restrict,command="/bin/sh ')).toBe(true)
  })

  it('refuses to build for an sshd that does not know verify-required', () => {
    expect(codeOf(() => buildSupportLine(input({ sshd: { major: 8, minor: 3 } })))).toBe('sshd_too_old')
    expect(codeOf(() => buildSupportLine(input({ sshd: { major: 8, minor: 2 } })))).toBe('sshd_too_old')
    expect(codeOf(() => buildSupportLine(input({ sshd: { major: 7, minor: 9 } })))).toBe('sshd_too_old')
    expect(codeOf(() => buildSupportLine(input({ sshd: { major: 8, minor: 4 } })))).toBe('no error')
  })

  it('refuses a key that is not a named sk-ssh-ed25519 key', () => {
    const plain = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('ssh-ed25519'),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 7),
    ]).toString('base64')
    expect(codeOf(() => buildSupportLine(input({ key: { ...TEST_ONLY_KEYS[0], pub: plain } })))).toBe('key_invalid')
    expect(codeOf(() => buildSupportLine(input({ key: { ...TEST_ONLY_KEYS[0], name: 'key 1' } })))).toBe('key_invalid')
    expect(codeOf(() => buildSupportLine(input({ key: { ...TEST_ONLY_KEYS[0], name: 'k";id;"' } })))).toBe('key_invalid')
  })

  it('refuses a grant id that is not a lowercase UUID v4', () => {
    expect(codeOf(() => buildSupportLine(input({ grantId: 'x' })))).toBe('grant_id_invalid')
    expect(codeOf(() => buildSupportLine(input({ grantId: GRANT.toUpperCase() })))).toBe('grant_id_invalid')
    expect(codeOf(() => buildSupportLine(input({ grantId: GRANT + ' --key key2' })))).toBe('grant_id_invalid')
  })

  it('refuses a consent version that is not a small positive integer', () => {
    for (const v of [0, -1, 1.5, 10000, Number.NaN]) {
      expect(codeOf(() => buildSupportLine(input({ consentVersion: v })))).toBe('consent_version_invalid')
    }
  })

  it.each([
    ['a space', '/Users/some one/marveen/scripts/support-dispatch.sh'],
    ['a double quote', '/opt/mar"veen/support-dispatch.sh'],
    ['a dollar sign', '/opt/$HOME/support-dispatch.sh'],
    ['a semicolon', '/opt/marveen/x.sh;id'],
    ['a backtick', '/opt/marveen/`id`.sh'],
    ['a relative path', 'scripts/support-dispatch.sh'],
    ['an empty path', ''],
    ['a newline', '/opt/marveen/x.sh\nid'],
  ])('refuses a dispatcher path with %s', (_label, dispatchPath) => {
    expect(codeOf(() => buildSupportLine(input({ dispatchPath })))).toBe('install_path_unsupported')
  })

  it('refuses a missing, a ranged or a third source', () => {
    expect(codeOf(() => buildSupportLine(input({ fromCidrs: [] })))).toBe('from_invalid')
    expect(codeOf(() => buildSupportLine(input({ fromCidrs: ['203.0.113.0/24'] })))).toBe('from_invalid')
    expect(codeOf(() => buildSupportLine(input({ fromCidrs: ['203.0.113.7/32', '!203.0.113.8/32'] })))).toBe('from_invalid')
    expect(
      codeOf(() => buildSupportLine(input({ fromCidrs: ['203.0.113.7/32', '203.0.113.8/32', '203.0.113.9/32'] }))),
    ).toBe('from_invalid')
  })
})

describe('sshdAtLeast', () => {
  it('compares versions by major then minor', () => {
    expect(sshdAtLeast({ major: 10, minor: 0 }, SUPPORT_MIN_SSHD)).toBe(true)
    expect(sshdAtLeast({ major: 8, minor: 10 }, SUPPORT_MIN_SSHD)).toBe(true)
    expect(sshdAtLeast({ major: 8, minor: 4 }, SUPPORT_MIN_SSHD)).toBe(true)
    expect(sshdAtLeast({ major: 8, minor: 3 }, SUPPORT_MIN_SSHD)).toBe(false)
    expect(sshdAtLeast({ major: 7, minor: 99 }, SUPPORT_MIN_SSHD)).toBe(false)
  })
})

const BRIDGE_UUID = '11111111-2222-4333-8444-555555555555'
const BRIDGE_LINE =
  'restrict,port-forwarding,permitopen="localhost:3420" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC marveen-remote:' +
  BRIDGE_UUID
const PERSONAL_LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH someone on a laptop'
const LINE1 = buildSupportLine(input({ key: TEST_ONLY_KEYS[0] }))
const LINE2 = buildSupportLine(input({ key: TEST_ONLY_KEYS[1] }))

describe('splitAuthorizedKeysLine', () => {
  it('reads a line without options', () => {
    expect(splitAuthorizedKeysLine(PERSONAL_LINE)).toEqual({
      options: null,
      keyType: 'ssh-ed25519',
      blob: 'AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH',
      comment: 'someone on a laptop',
    })
  })

  it('keeps a quoted option value with spaces and an escaped quote in one field', () => {
    const fields = splitAuthorizedKeysLine('command="echo \\"a b\\" c",restrict ssh-ed25519 AAAA cmt')
    expect(fields?.options).toBe('command="echo \\"a b\\" c",restrict')
    expect(fields?.blob).toBe('AAAA')
  })

  it('returns null for a blank line, a comment and an unbalanced quote', () => {
    expect(splitAuthorizedKeysLine('')).toBeNull()
    expect(splitAuthorizedKeysLine('   ')).toBeNull()
    expect(splitAuthorizedKeysLine('# marveen-support:x')).toBeNull()
    expect(splitAuthorizedKeysLine('command="oops ssh-ed25519 AAAA c')).toBeNull()
    expect(splitAuthorizedKeysLine('options-only')).toBeNull()
  })
})

describe('isSupportLine', () => {
  it('recognises a built line, and a pinned key under any other options and comment', () => {
    expect(isSupportLine(LINE1, TEST_ONLY_BLOBS)).toBe(true)
    expect(isSupportLine('sk-ssh-ed25519@openssh.com ' + TEST_ONLY_BLOB_1 + ' innocent', TEST_ONLY_BLOBS)).toBe(true)
    expect(isSupportLine('no-touch-required sk-ssh-ed25519@openssh.com ' + TEST_ONLY_BLOB_1, TEST_ONLY_BLOBS)).toBe(true)
  })

  it('recognises the support comment on a key that is not pinned (a line of an older release)', () => {
    expect(isSupportLine(PERSONAL_LINE.replace('someone on a laptop', SUPPORT_COMMENT_PREFIX + GRANT + ':key1'), TEST_ONLY_BLOBS)).toBe(true)
  })

  it('recognises a mangled copy that no longer parses', () => {
    expect(isSupportLine('command="oops sk-ssh-ed25519@openssh.com ' + TEST_ONLY_BLOB_1 + ' x', TEST_ONLY_BLOBS)).toBe(true)
  })

  it('leaves the Bridge line, a personal key, a blank line and a # comment alone', () => {
    expect(isSupportLine(BRIDGE_LINE, TEST_ONLY_BLOBS)).toBe(false)
    expect(isSupportLine(PERSONAL_LINE, TEST_ONLY_BLOBS)).toBe(false)
    expect(isSupportLine('', TEST_ONLY_BLOBS)).toBe(false)
    expect(isSupportLine('# ' + LINE1, TEST_ONLY_BLOBS)).toBe(false)
  })
})

// The same key bytes, written differently. A removal must not depend on
// whether some sshd reads such a spelling as the key.
describe('a pinned key is recognised by its bytes, not by its spelling', () => {
  const noPadding = TEST_ONLY_BLOB_1.replace(/=+$/, '')
  const lastChar = noPadding[noPadding.length - 1]
  const spareBits = noPadding.slice(0, -1) + String.fromCharCode(lastChar.charCodeAt(0) + 1) + '='
  const spelled: Array<[string, string]> = [
    ['without the padding', noPadding],
    ['with the spare bits of the last character set', spareBits],
    ['with more text after the padding', TEST_ONLY_BLOB_1 + 'QUJD'],
    ['with a second padding sign', TEST_ONLY_BLOB_1 + '='],
    ['with a character that is not base64 inside', TEST_ONLY_BLOB_1.slice(0, 20) + '.' + TEST_ONLY_BLOB_1.slice(20)],
    ['with extra bytes appended', noPadding + 'AAAA'],
  ]

  it('the fixtures really are other spellings of the same bytes', () => {
    expect(TEST_ONLY_BLOB_1.endsWith('=')).toBe(true)
    const bytes = Buffer.from(TEST_ONLY_BLOB_1, 'base64')
    for (const [, text] of spelled) {
      expect(text).not.toBe(TEST_ONLY_BLOB_1)
      expect(TEST_ONLY_BLOBS.has(text)).toBe(false)
      expect(Buffer.from(text, 'base64').subarray(0, bytes.length).equals(bytes)).toBe(true)
    }
  })

  it.each(spelled)('a copy %s is a support line, under a neutral comment', (_label, text) => {
    expect(holdsPinnedKey(text, TEST_ONLY_BLOBS)).toBe(true)
    const line = 'sk-ssh-ed25519@openssh.com ' + text + ' innocent'
    expect(isSupportLine(line, TEST_ONLY_BLOBS)).toBe(true)
    expect(removeSupportLines([PERSONAL_LINE, line].join('\n') + '\n', TEST_ONLY_BLOBS)).toEqual({ content: PERSONAL_LINE + '\n', removed: 1 })
    expect(reconcileSupportLines([line, LINE1].join('\n') + '\n', [LINE1], TEST_ONLY_BLOBS)).toMatchObject({ kept: 1, removed: 1 })
  })

  it.each(spelled)('a copy %s is found in a line that no longer parses, too', (_label, text) => {
    expect(isSupportLine('command="oops sk-ssh-ed25519@openssh.com ' + text + ' x', TEST_ONLY_BLOBS)).toBe(true)
  })

  it('the second pinned key is recognised the same way, not only the first', () => {
    const second = TEST_ONLY_KEYS[1].pub.replace(/=+$/, '')
    expect(second).not.toBe(TEST_ONLY_KEYS[1].pub)
    expect(isSupportLine('sk-ssh-ed25519@openssh.com ' + second + ' innocent', TEST_ONLY_BLOBS)).toBe(true)
  })

  it('a key that differs in one byte, a shorter one and a key that only CONTAINS ours later are not ours', () => {
    const bytes = Buffer.from(TEST_ONLY_BLOB_1, 'base64')
    const oneOff = Buffer.from(bytes)
    oneOff[40] ^= 1
    const cut = bytes.subarray(0, bytes.length - 1)
    const later = Buffer.concat([Buffer.from([0]), bytes])
    for (const other of [oneOff, cut, later]) {
      const text = other.toString('base64')
      expect(holdsPinnedKey(text, TEST_ONLY_BLOBS)).toBe(false)
      expect(isSupportLine('sk-ssh-ed25519@openssh.com ' + text + ' innocent', TEST_ONLY_BLOBS)).toBe(false)
    }
    expect(holdsPinnedKey('', TEST_ONLY_BLOBS)).toBe(false)
    expect(holdsPinnedKey('innocent', TEST_ONLY_BLOBS)).toBe(false)
  })

  // An empty pin decodes to no bytes, and every key "starts with" no bytes:
  // such a pin must recognise nothing, or every line of the file would go.
  it('with no pinned key, or with an empty one, nothing is recognised by its bytes', () => {
    expect(holdsPinnedKey(TEST_ONLY_BLOB_1, new Set())).toBe(false)
    expect(holdsPinnedKey(TEST_ONLY_BLOB_1, new Set(['']))).toBe(false)
    expect(holdsPinnedKey('innocent', new Set(['', '====']))).toBe(false)
    expect(isSupportLine(PERSONAL_LINE, new Set(['']))).toBe(false)
    expect(removeSupportLines(PERSONAL_LINE + '\n' + BRIDGE_LINE + '\n', new Set([''])).removed).toBe(0)
  })

  it('the merge takes a respelled copy out when it puts the grant in', () => {
    const copy = 'sk-ssh-ed25519@openssh.com ' + noPadding + ' handy'
    const out = mergeSupportLines([PERSONAL_LINE, copy].join('\n') + '\n', [LINE1], TEST_ONLY_BLOBS)
    expect(out).toEqual({ content: [PERSONAL_LINE, LINE1].join('\n') + '\n', replaced: 1 })
  })
})

describe('removeSupportLines', () => {
  it('removes BOTH lines of a grant and keeps every other line byte for byte', () => {
    const file = [PERSONAL_LINE, LINE1, BRIDGE_LINE, LINE2, '# a note'].join('\n') + '\n'
    const out = removeSupportLines(file, TEST_ONLY_BLOBS)
    expect(out.removed).toBe(2)
    expect(out.content).toBe([PERSONAL_LINE, BRIDGE_LINE, '# a note'].join('\n') + '\n')
  })

  it('never removes a marveen-remote line', () => {
    const out = removeSupportLines(BRIDGE_LINE + '\n' + LINE1 + '\n', TEST_ONLY_BLOBS)
    expect(out.content).toBe(BRIDGE_LINE + '\n')
  })

  it('returns the content untouched when there is nothing to remove', () => {
    const file = PERSONAL_LINE + '\n\n' + BRIDGE_LINE
    const out = removeSupportLines(file, TEST_ONLY_BLOBS)
    expect(out).toEqual({ content: file, removed: 0 })
  })

  it('leaves an empty file empty', () => {
    expect(removeSupportLines(LINE1 + '\n', TEST_ONLY_BLOBS)).toEqual({ content: '', removed: 1 })
    expect(countSupportLines('', TEST_ONLY_BLOBS)).toBe(0)
  })
})

describe('mergeSupportLines', () => {
  it('appends the grant after the existing lines', () => {
    const out = mergeSupportLines(PERSONAL_LINE + '\n' + BRIDGE_LINE + '\n', [LINE1, LINE2], TEST_ONLY_BLOBS)
    expect(out.replaced).toBe(0)
    expect(out.content).toBe([PERSONAL_LINE, BRIDGE_LINE, LINE1, LINE2].join('\n') + '\n')
  })

  it('replaces the lines of an earlier grant: one grant per machine', () => {
    const older = buildSupportLine(input({ grantId: OTHER_GRANT }))
    const out = mergeSupportLines([older, BRIDGE_LINE].join('\n') + '\n', [LINE1, LINE2], TEST_ONLY_BLOBS)
    expect(out.replaced).toBe(1)
    expect(out.content).toBe([BRIDGE_LINE, LINE1, LINE2].join('\n') + '\n')
    expect(countSupportLines(out.content, TEST_ONLY_BLOBS)).toBe(2)
  })

  it('replaces a loosened copy of a pinned key instead of leaving it next to the canonical line', () => {
    const loose = 'sk-ssh-ed25519@openssh.com ' + TEST_ONLY_BLOB_1 + ' handy'
    const out = mergeSupportLines(loose + '\n', [LINE1], TEST_ONLY_BLOBS)
    expect(out.content).toBe(LINE1 + '\n')
  })

  it('refuses an empty grant', () => {
    expect(() => mergeSupportLines('', [], TEST_ONLY_BLOBS)).toThrow()
  })

  // What reaches the file is decided here, so the closed list must hold here
  // too: a "line" that is two lines, or a line nothing would ever remove.
  const FOREIGN_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ intruder'

  it.each([
    ['a line feed', '\n'],
    ['a carriage return', '\r'],
    ['a carriage return and a line feed', '\r\n'],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
    ['a NUL', '\0'],
  ])('refuses a built line that carries a second key behind %s', (_label, separator) => {
    expect(codeOf(() => mergeSupportLines(PERSONAL_LINE + '\n', [LINE1 + separator + FOREIGN_KEY], TEST_ONLY_BLOBS))).toBe(
      'line_refused',
    )
  })

  // A built line is printable ASCII, so nothing else is taken: how sshd reads
  // a NUL in the middle of a line is not something this check has to know.
  it.each([
    ['a foreign key, a NUL, then our comment', FOREIGN_KEY + '\0' + 'marveen-support:' + GRANT + ':k1'],
    ['a foreign key, a NUL, then a whole built line', FOREIGN_KEY + '\0' + LINE1],
    ['a built line with a tab in it', LINE1 + '\tx'],
    ['a built line with a DEL at the end', LINE1 + '\x7f'],
    ['a built line with a no-break space at the end', LINE1 + '\u00a0'],
    ['a built line with a letter above ASCII in the comment', LINE1 + '\u00e9'],
  ])('refuses %s', (_label, line) => {
    expect(codeOf(() => mergeSupportLines(PERSONAL_LINE + '\n', [line], TEST_ONLY_BLOBS))).toBe('line_refused')
  })

  it('says which of the two refusals it was', () => {
    expect(() => mergeSupportLines('', [LINE1 + '\v' + FOREIGN_KEY], TEST_ONLY_BLOBS)).toThrow(/not printable ASCII/)
    expect(() => mergeSupportLines('', [FOREIGN_KEY], TEST_ONLY_BLOBS)).toThrow(/not recognised as a support line/)
  })

  it('refuses a built line with a trailing line break', () => {
    expect(codeOf(() => mergeSupportLines('', [LINE1 + '\n'], TEST_ONLY_BLOBS))).toBe('line_refused')
  })

  it('refuses a plain foreign key handed in as a line', () => {
    expect(codeOf(() => mergeSupportLines(PERSONAL_LINE + '\n', [FOREIGN_KEY], TEST_ONLY_BLOBS))).toBe('line_refused')
  })

  it('refuses the whole grant when only its last line is not a support line', () => {
    expect(codeOf(() => mergeSupportLines('', [LINE1, LINE2, FOREIGN_KEY], TEST_ONLY_BLOBS))).toBe('line_refused')
  })

  it('refuses a comment line and a blank line: sshd would ignore them, and so would every removal', () => {
    expect(codeOf(() => mergeSupportLines('', ['# marveen-support:note'], TEST_ONLY_BLOBS))).toBe('line_refused')
    expect(codeOf(() => mergeSupportLines('', [''], TEST_ONLY_BLOBS))).toBe('line_refused')
  })
})

describe('buildSupportGrantLines', () => {
  it('builds one line per key, each exactly what buildSupportLine makes', () => {
    expect(buildSupportGrantLines(grantInput())).toEqual([LINE1, LINE2])
    expect(buildSupportGrantLines(grantInput({ keys: [TEST_ONLY_KEYS[1]] }))).toEqual([LINE2])
  })

  it('every line it builds passes the merge', () => {
    const lines = buildSupportGrantLines(grantInput({ fromCidrs: [TEST_ONLY_FROM[0], TEST_ONLY_FROM_V6] }))
    expect(mergeSupportLines('', lines, TEST_ONLY_BLOBS).content).toBe(lines.join('\n') + '\n')
  })

  const key1 = TEST_ONLY_KEYS[0]
  const thirdBlob = skBlob({ key: Buffer.alloc(32, 0x07) })
  it.each([
    ['no key', grantInput({ keys: [] })],
    ['no source', grantInput({ fromCidrs: [] })],
    ['the same key twice', grantInput({ keys: [key1, { ...key1, name: 'other' }] })],
    ['the same name twice', grantInput({ keys: [key1, { ...TEST_ONLY_KEYS[1], name: key1.name }] })],
    [
      'a third key',
      grantInput({ keys: [...TEST_ONLY_KEYS, { name: 'key3', pub: thirdBlob, fingerprint: fingerprintOfBlob(thirdBlob) }] }),
    ],
    ['a fingerprint that belongs to another key', grantInput({ keys: [{ ...key1, fingerprint: TEST_ONLY_KEYS[1].fingerprint }] })],
    ['the same source twice', grantInput({ fromCidrs: [TEST_ONLY_FROM[0], TEST_ONLY_FROM[0]] })],
  ])('refuses %s, as the pins check does', (_label, grant) => {
    expect(codeOf(() => buildSupportGrantLines(grant))).toBe('pins_invalid')
  })

  it('refuses what the line builder refuses, with the builder\'s own code', () => {
    expect(codeOf(() => buildSupportGrantLines(grantInput({ sshd: { major: 8, minor: 2 } })))).toBe('sshd_too_old')
    expect(codeOf(() => buildSupportGrantLines(grantInput({ grantId: 'not-a-uuid' })))).toBe('grant_id_invalid')
    expect(codeOf(() => buildSupportGrantLines(grantInput({ dispatchPath: DISPATCH + '\n' + FOREIGN_TAIL })))).toBe(
      'install_path_unsupported',
    )
  })
})

describe('reconcileSupportLines', () => {
  it('keeps the expected lines and everything that is not support', () => {
    const file = [PERSONAL_LINE, LINE1, BRIDGE_LINE, LINE2].join('\n') + '\n'
    expect(reconcileSupportLines(file, [LINE1, LINE2], TEST_ONLY_BLOBS)).toEqual({
      content: file,
      kept: 2,
      removed: 0,
      missing: 0,
      lineEndOnly: 0,
    })
  })

  it.each([
    ['a dropped verify-required', LINE1.replace(',verify-required', '')],
    ['a dropped restrict', LINE1.replace('restrict,', '')],
    ['a dropped from', LINE1.replace(',from="203.0.113.7/32"', '')],
    ['an added expiry-time', LINE1.replace(',verify-required', ',expiry-time="209901010000",verify-required')],
    ...GIVES_BACK.map((o): [string, string] => ['an added ' + o.split('=')[0] + ' after restrict', LINE1.replace('restrict,', 'restrict,' + o + ',')]),
    ...GIVES_BACK.map((o): [string, string] => ['an added ' + o.split('=')[0] + ' at the end', LINE1.replace(',verify-required', ',verify-required,' + o)]),
    ['a widened from', LINE1.replace('203.0.113.7/32', '203.0.113.7/32,*')],
    ['another command', LINE1.replace('/bin/sh ', '/bin/bash -c id; /bin/sh ')],
    ['a bare copy of the pinned key', 'sk-ssh-ed25519@openssh.com ' + TEST_ONLY_BLOB_1 + ' handy'],
  ])('removes a line with %s', (_label, tampered) => {
    const file = [BRIDGE_LINE, tampered, LINE2].join('\n') + '\n'
    const out = reconcileSupportLines(file, [LINE1, LINE2], TEST_ONLY_BLOBS)
    expect(out.removed).toBe(1)
    expect(out.kept).toBe(1)
    expect(out.missing).toBe(1)
    expect(out.content).toBe([BRIDGE_LINE, LINE2].join('\n') + '\n')
  })

  it('removes a second copy of an expected line', () => {
    const out = reconcileSupportLines([LINE1, LINE1].join('\n') + '\n', [LINE1], TEST_ONLY_BLOBS)
    expect(out).toEqual({ content: LINE1 + '\n', kept: 1, removed: 1, missing: 0, lineEndOnly: 0 })
  })

  it('with no live grant removes every support line and never adds one', () => {
    const out = reconcileSupportLines([LINE1, BRIDGE_LINE, LINE2].join('\n') + '\n', [], TEST_ONLY_BLOBS)
    expect(out).toEqual({ content: BRIDGE_LINE + '\n', kept: 0, removed: 2, missing: 0, lineEndOnly: 0 })
  })

  // An editor that saves the file with CR LF line ends changes every line by
  // one byte. The lines still go (only the byte-for-byte built line stays),
  // but the result says that this, and nothing else, is what happened.
  it('a file saved with CR LF line ends: the lines go, and the count says it was the line end only', () => {
    const file = [PERSONAL_LINE, LINE1, LINE2].join('\r\n') + '\r\n'
    const out = reconcileSupportLines(file, [LINE1, LINE2], TEST_ONLY_BLOBS)
    expect(out).toMatchObject({ kept: 0, removed: 2, missing: 2, lineEndOnly: 2 })
    expect(out.content).toBe(PERSONAL_LINE + '\r\n')
  })

  it('counts a line as "line end only" for exactly one carriage return after an expected line, nothing else', () => {
    const loosened = LINE2.replace(',verify-required', '')
    const cases: Array<[string, number]> = [
      [LINE1 + '\r', 1],
      [LINE1 + '\r\r', 0],
      [LINE1 + ' \r', 0],
      [LINE1 + ' ', 0],
      [loosened + '\r', 0],
      [buildSupportLine(input({ grantId: OTHER_GRANT })) + '\r', 0],
    ]
    for (const [line, expected] of cases) {
      const out = reconcileSupportLines(line + '\n', [LINE1, LINE2], TEST_ONLY_BLOBS)
      expect([line, out.removed, out.lineEndOnly]).toEqual([line, 1, expected])
    }
    expect(reconcileSupportLines([LINE1, LINE2].join('\n') + '\n', [LINE1, LINE2], TEST_ONLY_BLOBS)).toMatchObject({
      kept: 2,
      removed: 0,
      lineEndOnly: 0,
    })
    // An intact line next to a CR LF copy of itself: the intact one stays, the copy goes as a line-end case.
    expect(reconcileSupportLines([LINE1, LINE1 + '\r'].join('\n') + '\n', [LINE1], TEST_ONLY_BLOBS)).toMatchObject({
      kept: 1,
      removed: 1,
      lineEndOnly: 1,
    })
    // With no live grant nothing is expected, so nothing is "the line end only".
    expect(reconcileSupportLines(LINE1 + '\r\n', [], TEST_ONLY_BLOBS)).toMatchObject({ removed: 1, lineEndOnly: 0 })
  })

  it('reports a missing expected line and does NOT create it', () => {
    const file = BRIDGE_LINE + '\n'
    expect(reconcileSupportLines(file, [LINE1], TEST_ONLY_BLOBS)).toEqual({
      content: file,
      kept: 0,
      removed: 0,
      missing: 1,
      lineEndOnly: 0,
    })
  })
})
