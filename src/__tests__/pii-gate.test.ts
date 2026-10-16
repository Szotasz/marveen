/**
 * The personal-data gate's pure core. Every literal below that WOULD be flagged is
 * assembled at runtime (`j(...)`): this file is itself part of what gets pushed,
 * and a test file that carries a real-looking address or path would trip the gate it
 * tests, then need an exception that blinds it. Fragments joined at run time keep
 * the file clean AND the assertions honest.
 */
import { describe, it, expect } from 'vitest';
import {
  detect, scanAdded, parseAddedLines, parseDenylist, ibanChecksumOk, emailIsPerson,
  piiHash, piiExceptionReason, invalidPiiExceptions, EMPTY_DENYLIST, PII_EXCEPTIONS,
  type AddedLine, type PiiException,
} from '../security/pii-gate.js';

const j = (...p: string[]) => p.join('');
const AT = '@';
const kinds = (t: string, o = {}) => detect(t, o).map((h) => h.detector);

describe('e-mail', () => {
  it('flags a person-shaped address', () => {
    expect(kinds(j('contact: bartok.bela', AT, 'real-company.hu'))).toEqual(['email']);
  });
  it.each([
    j('kovacs.ilona', AT, 'example.com'), j('kovacs.ilona', AT, 'example.org'), j('kovacs.ilona', AT, 'mail.example.net'),
    j('kovacs.ilona', AT, 'host.test'), j('kovacs.ilona', AT, 'x.invalid'), j('kovacs.ilona', AT, 'box.localhost'),
    j('kovacs.ilona', AT, 'srv.local'), j('kovacs.ilona', AT, 'srv.internal'), j('kovacs.ilona', AT, 'ceg.example'),
    j('12345+name', AT, 'users.noreply.github.com'),
    j('noreply', AT, 'anthropic.com'), j('no-reply', AT, 'service.io'),
    j('dependabot[bot]', AT, 'users.noreply.github.com'), j('bot', AT, 'corp.io'),
  ])('lets a reserved or machine address through: %s', (addr) => {
    expect(kinds(`x ${addr} y`)).toEqual([]);
  });
  it('does not mistake npm specs or scoped packages for addresses', () => {
    expect(kinds(j('react', AT, '18.2.0 and ', AT, 'types/node and left-pad', AT, 'latest'))).toEqual([]);
  });
  it('lets role mailboxes, ssh remotes and system addresses through', () => {
    expect(kinds(j('support', AT, 'real-company.hu hello', AT, 'real-company.hu'))).toEqual([]);
    expect(kinds(j('git', AT, 'github.com:org/repo.git'))).toEqual([]);
    expect(kinds(j('x', AT, 'my-project.iam.gserviceaccount.com'))).toEqual([]);
    expect(kinds(j('CAxyz123', AT, 'mail.gmail.com'))).toEqual([]);
  });
  it('lets a placeholder local part through even on a real provider', () => {
    expect(kinds(j('example', AT, 'gmail.com'))).toEqual([]);
    expect(kinds(j('user', AT, 'gmail.com'))).toEqual([]);
  });
  it('lets a synthetic domain through: one-letter .hu labels and the placeholder words', () => {
    for (const d of ['b.hu', 'x.hu', 'pelda.hu', 'mail.ceg.hu', 'customer.hu', 'your.domain', 'company.com']) {
      expect(kinds(j('kovacs.ilona', AT, d))).toEqual([]);
    }
  });
  it('a one-letter label under another TLD can be a real domain and is flagged (Sam, KISEBB 6)', () => {
    for (const d of ['x.com', 'q.com', 'x.co']) expect(kinds(j('kovacs.janos', AT, d))).toEqual(['email']);
  });
  it('still flags a free-mail provider and an ordinary company domain', () => {
    expect(kinds(j('kovacs.ilona', AT, 'gmail.com'))).toEqual(['email']);
    expect(kinds(j('kovacs.ilona', AT, 'real-company.hu'))).toEqual(['email']);
  });
  it('does not read the userinfo of a URL as an address', () => {
    expect(kinds(j('https://TOKEN', AT, 'github.com/o/r'))).toEqual([]);
    expect(kinds(j('https://x-access-token:abc', AT, 'github.com/o/r.git'))).toEqual([]);
    // ...but an address after a plain colon is still an address
    expect(kinds(j('From: kovacs.ilona', AT, 'gmail.com'))).toEqual(['email']);
  });
  it.each(['me.com', 'wp.pl', 'yahoo.co.uk', 'hotmail.co.uk', 'yahoo.co.jp', 'qq.com'])(
    'flags a real mail provider even when its registrable label is short or sits under a second-level suffix: %s', (d) => {
      expect(kinds(j('kovacs.janos', AT, d))).toEqual(['email']);
    });
  it('a placeholder local part excuses only a free-mail provider, never a custom domain', () => {
    expect(kinds(j('me', AT, 'kovacsjanos.hu'))).toEqual(['email']);
    expect(kinds(j('mail', AT, 'kovacsjanos.hu'))).toEqual(['email']);
    expect(kinds(j('name', AT, 'kovacsjanos.hu'))).toEqual(['email']);
    expect(kinds(j('example', AT, 'gmail.com'))).toEqual([]);
  });
  it('judges the placeholder WORDS on the registrable label, not on any subdomain', () => {
    expect(kinds(j('kovacs', AT, 'corp.mol.hu'))).toEqual(['email']);
    expect(kinds(j('kovacs', AT, 'mail.ceg.hu'))).toEqual([]);
  });
  it('emailIsPerson agrees with detect', () => {
    expect(emailIsPerson(j('kovacs.ilona', AT, 'example.com'))).toBe(false);
    expect(emailIsPerson(j('kovacs.ilona', AT, 'gmail.com'))).toBe(true);
  });
  it('finds every address on a line, not just the first', () => {
    expect(kinds(j('kovacs.ilona', AT, 'one-corp.hu, szabo.eva', AT, 'two-corp.hu'))).toEqual(['email', 'email']);
  });
});

describe('local path', () => {
  it('flags a real-looking unix and mac account', () => {
    expect(kinds(j('/ho', 'me/', 'bartok', '/repo'))).toEqual(['local-path']);
    expect(kinds(j('/Us', 'ers/', 'kovacs', '/Desktop'))).toEqual(['local-path']);
  });
  it('flags the account even with no trailing slash (a quoted path)', () => {
    expect(kinds(j('"/ho', 'me/', 'bartok', '"'))).toEqual(['local-path']);
  });
  it('flags a windows profile in both slash styles and escaped backslashes', () => {
    expect(kinds(j('C:', '\\Us', 'ers\\', 'szabo', '\\x'))).toEqual(['local-path']);
    expect(kinds(j('C:', '/Us', 'ers/', 'szabo', '/x'))).toEqual(['local-path']);
    expect(kinds(j('C:', '\\\\Us', 'ers\\\\', 'szabo', '\\\\x'))).toEqual(['local-path']);
  });
  it.each(['u', 'user', 'foo', 'you', 'runner', 'ubuntu', 'Shared', 'USER'])(
    'lets the synthetic account %s through', (name) => {
      expect(kinds(j('/ho', 'me/', name, '/x'))).toEqual([]);
    });
  it.each(['$USER', '${HOME}', '<user>', '%u', '~'])('lets a placeholder through: %s', (ph) => {
    expect(kinds(j('/ho', 'me/', ph, '/x'))).toEqual([]);
  });
  it('does not read sentence punctuation as part of the account name', () => {
    expect(kinds(j('use the placeholder /ho', 'me/', 'u.'))).toEqual([]);
    expect(kinds(j('path is /ho', 'me/', 'user, not mine'))).toEqual([]);
    expect(kinds(j('but /ho', 'me/', 'bartok.'))).toEqual(['local-path']);
  });
  it('flags the WSL form of a windows profile, a lower-case users folder and a JSON-escaped path', () => {
    expect(kinds(j('/mnt/c/Us', 'ers/', 'KovacsJanos', '/Desktop'))).toEqual(['local-path']);
    expect(kinds(j('C:', '\\us', 'ers\\', 'kovacsjanos'))).toEqual(['local-path']);
    expect(kinds(j('"path": "\\/ho', 'me\\/', 'kovacsjanos', '\\/x"'))).toEqual(['local-path']);
  });
  it('the WSL form of a placeholder account still passes', () => {
    expect(kinds(j('/mnt/c/Us', 'ers/', 'Public', '/x'))).toEqual([]);
  });
  it('does not fire on a path that merely contains the word', () => {
    expect(kinds('see src/home/index.ts and /usr/share/homepage')).toEqual([]);
  });
});

describe('phone, IBAN, HU account and tax number', () => {
  it('flags a +36 number in the usual spellings', () => {
    expect(kinds(j('+36 20 ', '481 ', '9275'))).toEqual(['phone']);
    expect(kinds(j('+3620', '4819275'))).toEqual(['phone']);
    expect(kinds(j('06-30-', '481-', '9275'))).toEqual(['phone']);
  });
  // assembled at run time: a literal number in this file would trip the gate it tests
  const hu = (cc: string, sep: string[], g: string[]) => cc + g.map((x, i) => (sep[i] ?? '') + x).join('');
  it.each([
    ['06', ['/', '/', '-'], ['30', '987', '6543']],
    ['+36', ['-', '/', '-'], ['30', '987', '6543']],
    ['06', [' (', ') ', ' '], ['30', '987', '6543']],
    ['06', [' ', ' ', ' '], ['30', '987', '6543']],
    ['+36', [' ', ' ', ' '], ['30', '987', '6543']],
    ['06', ['', ' ', ' '], ['30', '987', '6543']],
    ['+36', ['.', '.', '.'], ['30', '987', '6543']],
  ] as [string, string[], string[]][])('flags the Hungarian spelling #%#', (cc, sep, g) => {
    const n = hu(cc, sep, g);
    expect(kinds(`call ${n} now`)).toEqual(['phone']);
  });
  it('lets an obviously invented number through', () => {
    expect(kinds(j('+36 1 ', '234 ', '5678'))).toEqual([]);
    expect(kinds(j('+36 20 000 ', '0000'))).toEqual([]);
  });
  it('a subscriber number that ends in a year-like group is still a number (Sam, KOZEPES 3)', () => {
    for (const n of [['06 30 987 ', '2024'], ['+36 30 987 ', '2019'], ['+36 20 987 ', '2021'], ['06-30-555-', '2023']]) {
      expect(kinds(`call ${j(...n)} now`)).toEqual(['phone']);
    }
  });
  it('does not call a date range or a counting sequence a phone number', () => {
    expect(kinds('release 06-26 / 2026-07 and 06 07 08 09 10')).toEqual([]);
  });
  it('does not call a version, date or port a phone number', () => {
    expect(kinds('v1.2.3 2026-10-13 port 8080 build 20261013063000')).toEqual([]);
  });
  it('flags an IBAN only when the checksum passes', () => {
    const ok = j('GB82', ' WEST', ' 1234', ' 5698', ' 7654', ' 32');
    expect(ibanChecksumOk(ok)).toBe(true);
    expect(kinds(`iban ${ok}`)).toEqual(['iban']);
    expect(kinds(j('GB83', ' WEST', ' 1234', ' 5698', ' 7654', ' 32'))).toEqual([]);
  });
  it('flags a HU account and tax number shape', () => {
    expect(kinds(j('11773016-', '11111018'))).toEqual(['hu-account']);
    expect(kinds(j('11773016-', '11111018-', '00000000'))).toEqual(['hu-account']);
    expect(kinds(j('12345678-', '1-', '42'))).toEqual(['hu-taxid']);
  });
  it('does not mistake a timestamped filename for an account number', () => {
    expect(kinds('20261013-063000-upstream-pr-figyelo-0625.md')).toEqual([]);
  });
});

describe('denylist', () => {
  it('matches a literal case-insensitively and a regex rule', () => {
    const dl = parseDenylist(['# comment', '', 'Teszt Elek', 're:acme-\\d+'].join('\n'));
    expect(kinds('by teszt elek today', { denylist: dl })).toEqual(['denylist']);
    expect(kinds('id acme-42', { denylist: dl })).toEqual(['denylist']);
    expect(kinds('nobody here', { denylist: dl })).toEqual([]);
  });
  it('escapes a plain line, so a dot is a dot', () => {
    const dl = parseDenylist('a.b');
    expect(kinds('axb', { denylist: dl })).toEqual([]);
    expect(kinds('a.b', { denylist: dl })).toEqual(['denylist']);
  });
  it('THROWS on a rule it cannot compile instead of dropping it (fail-closed)', () => {
    expect(() => parseDenylist('re:(unclosed')).toThrow(/line 1/);
  });
  it('ignores a BOM on the first line', () => {
    expect(kinds('xyzzy', { denylist: parseDenylist('﻿xyzzy') })).toEqual(['denylist']);
  });
});

describe('scanAdded', () => {
  const L = (text: string): AddedLine[] => [{ file: 'a.ts', line: 7, text }];
  it('reports file, line and detector but never the matched text', () => {
    const r = scanAdded(L(j('x bartok.bela', AT, 'real-company.hu')), 'abc');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ file: 'a.ts', line: 7, detector: 'email', commit: 'abc' });
    expect(JSON.stringify(r.findings)).not.toContain('real-company');
  });
  it('exempts the e-mail in a commit trailer, but not a path in the same message', () => {
    const trailer = { file: 'commit message', line: 3, text: j('Co-Authored-By: A <kovacs.ilona', AT, 'real-company.hu>') };
    expect(scanAdded([trailer], 'c', { messageMode: true }).findings).toEqual([]);
    expect(scanAdded([trailer], 'c').findings).toHaveLength(1);
    const path = { file: 'commit message', line: 1, text: j('fixed in /ho', 'me/', 'bartok', '/x') };
    expect(scanAdded([path], 'c', { messageMode: true }).findings).toHaveLength(1);
  });
  it('applies an exception to exactly that literal in exactly that file', () => {
    const lit = j('bartok.bela', AT, 'real-company.hu');
    const ex: PiiException[] = [{ path: 'a.ts', sha256: piiHash(lit), reason: 'maintainer address published in the project README' }];
    expect(scanAdded(L(`x ${lit}`), 'c', { exceptions: ex }).findings).toEqual([]);
    expect(scanAdded(L(`x ${lit}`), 'c', { exceptions: ex }).exceptions).toHaveLength(1);
    // another file, another literal: the exception does not travel
    expect(scanAdded([{ file: 'b.ts', line: 1, text: `x ${lit}` }], 'c', { exceptions: ex }).findings).toHaveLength(1);
    expect(scanAdded(L(j('x other', AT, 'real-company.hu')), 'c', { exceptions: ex }).findings).toHaveLength(1);
  });
  it('the shipped exception table is valid (and starts empty)', () => {
    expect(invalidPiiExceptions(PII_EXCEPTIONS)).toEqual([]);
    expect(piiExceptionReason('a.ts', 'x', [])).toBeNull();
  });
  it('rejects a malformed exception: bad hash, thin reason, duplicate', () => {
    const good = { path: 'a', sha256: piiHash('x'), reason: 'a written reason that is long enough' };
    expect(invalidPiiExceptions([{ ...good, sha256: 'nothex' }]).length).toBeGreaterThan(0);
    expect(invalidPiiExceptions([{ ...good, reason: 'short' }]).length).toBeGreaterThan(0);
    expect(invalidPiiExceptions([good, good]).some((b) => /duplicate/.test(b.reason))).toBe(true);
  });
  it('EMPTY_DENYLIST changes nothing', () => {
    expect(kinds('anything', { denylist: EMPTY_DENYLIST })).toEqual([]);
  });
});

describe('parseAddedLines', () => {
  const addr = j('bartok.bela', AT, 'real-company.hu');

  it('returns added lines with their line numbers in the NEW file', () => {
    const patch = [
      'diff --git a/f.txt b/f.txt', 'index 1..2 100644', '--- a/f.txt', '+++ b/f.txt',
      '@@ -3,0 +4,2 @@', '+first', `+second ${addr}`,
    ].join('\n');
    const r = parseAddedLines(patch);
    expect(r.lines).toEqual([
      { file: 'f.txt', line: 4, text: 'first' },
      { file: 'f.txt', line: 5, text: `second ${addr}` },
    ]);
  });

  it('does NOT read an added line starting with "++" as a file header (the scan.ts failure class)', () => {
    const patch = [
      'diff --git a/t.md b/t.md', '--- a/t.md', '+++ b/t.md',
      '@@ -1,0 +1,2 @@', '+++ a table row', `+++ ${addr}`,
    ].join('\n');
    const r = parseAddedLines(patch);
    expect(r.lines.map((l) => l.text)).toEqual(['++ a table row', `++ ${addr}`]);
    expect(r.lines.every((l) => l.file === 't.md')).toBe(true);
  });

  it('never reports a removed or context line', () => {
    const patch = [
      'diff --git a/f b/f', '--- a/f', '+++ b/f',
      '@@ -1,3 +1,3 @@', ' context', `-removed ${addr}`, '+kept', ' tail',
    ].join('\n');
    const r = parseAddedLines(patch);
    expect(r.lines).toEqual([{ file: 'f', line: 2, text: 'kept' }]);
  });

  it('handles several hunks and several files in one patch', () => {
    const patch = [
      'diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '+one',
      '@@ -10,0 +11 @@', '+two',
      'diff --git a/b b/b', 'new file mode 100644', '--- /dev/null', '+++ b/b', '@@ -0,0 +1 @@', '+three',
    ].join('\n');
    expect(parseAddedLines(patch).lines).toEqual([
      { file: 'a', line: 1, text: 'one' }, { file: 'a', line: 11, text: 'two' }, { file: 'b', line: 1, text: 'three' },
    ]);
  });

  it('skips the "No newline" marker and a deleted file', () => {
    const patch = [
      'diff --git a/d b/d', 'deleted file mode 100644', '--- a/d', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone',
      'diff --git a/n b/n', '--- a/n', '+++ b/n', '@@ -0,0 +1 @@', '+tail', '\\ No newline at end of file',
    ].join('\n');
    expect(parseAddedLines(patch).lines).toEqual([{ file: 'n', line: 1, text: 'tail' }]);
  });

  it('records a binary change as unscanned instead of ignoring it', () => {
    const patch = ['diff --git a/i.png b/i.png', 'index 1..2 100644', 'Binary files a/i.png and b/i.png differ'].join('\n');
    const r = parseAddedLines(patch);
    expect(r.lines).toEqual([]);
    expect(r.binary.length).toBe(1);
  });

  it('reads a combined (merge) diff: only lines added against EVERY parent are new', () => {
    const patch = [
      'diff --cc f', 'index 1,2..3', '--- a/f', '+++ b/f',
      '@@@ -1,2 -1,2 +1,4 @@@', '  shared', '+ from-parent-2', ' +from-parent-1', `++resolved ${addr}`,
    ].join('\n');
    const r = parseAddedLines(patch);
    expect(r.lines).toEqual([{ file: 'f', line: 4, text: `resolved ${addr}` }]);
  });

  it('keeps a path with a space', () => {
    const patch = ['diff --git a/my doc.md b/my doc.md', '--- a/my doc.md', '+++ b/my doc.md\t', '@@ -0,0 +1 @@', '+x'].join('\n');
    expect(parseAddedLines(patch).lines[0].file).toBe('my doc.md');
  });
});
