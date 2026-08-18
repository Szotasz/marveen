/**
 * EVIDGUARD818. The gate's own tests.
 *
 * The synthetic secrets below are FAKE and this file is allowlisted by path --
 * which is itself part of what is under test: the allowlist must be path-based,
 * because a pattern-level exception would open the same hole everywhere.
 *
 * Every assertion here has a red probe behind it (documented in the PR): remove
 * the detector and these go red. A green test that would stay green with the
 * gate ripped out proves nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  runGate,
  scanFile,
  allowlistReason,
  ALLOWLISTED_PATHS,
  type ScanInput,
} from '../security/secret-gate.js';

const f = (path: string, content: string): ScanInput => ({ path, content });

/**
 * Assembled at runtime on purpose. Written out as a literal, GitHub's own push
 * protection rejects this file (measured 2026-08-18: "Stripe API Key", push
 * declined) -- which is a useful finding in itself: a second, vendor-format
 * control already exists on this repo. Our gate covers what that one cannot:
 * evidence paths, quoted channel material, and formats nobody has listed.
 */
const STRIPE_FIXTURE = ['sk', 'live', '51ABCDEFGHIJKLMNOPQRSTUV'].join('_');

describe('fail-closed', () => {
  it('an EMPTY file set FAILS -- the most common silent fail-open', () => {
    const r = runGate([]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].reason).toMatch(/EMPTY/);
  });

  it('a file that could not be read FAILS instead of passing quietly', () => {
    const r = runGate([{ path: 'assets/huge.bin', unreadable: { reason: 'file is 42.0 MB, above the 5 MB scan limit' } }]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].severity).toBe('unscannable');
    expect(r.findings[0].reason).toMatch(/could not read this file/);
  });

  it('a clean, readable set passes', () => {
    const r = runGate([f('src/index.ts', 'export const x = 1;\n')]);
    expect(r.ok).toBe(true);
    expect(r.scannedCount).toBe(1);
  });
});

describe('detector 1: path', () => {
  it.each([
    '.pre-ship-evidence/2026-07-22.md',
    'docs/.pre-ship-evidence/run.txt',
    'evidence/session.log',
    'transcripts/telegram-2026-07-22.json',
  ])('blocks %s regardless of content', (path) => {
    const r = runGate([f(path, 'teljesen artalmatlan szoveg')]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].detector).toBe('path');
  });
});

describe('detector 2: content', () => {
  it.each([
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n'],
    ['stripe key', `const k = "${STRIPE_FIXTURE}";`],
    ['elevenlabs header', 'headers: { "xi-api-key": "abcdef0123456789abcdef01" }'],
    ['jwt', 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['github token', 'GH=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['aws key id', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ])('blocks a %s in an ordinary file', (_name, body) => {
    const r = runGate([f('docs/notes.md', body)]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].detector).toBe('content');
  });

  it('catches BOTH separators and does not assume a length (Boni traps, EVIDLEAK818)', () => {
    // (a) Boni's first detector looked for `sk-` and returned ZERO on a key that
    //     used `sk_`. Zero looks reassuring, which is what makes it dangerous.
    // (b) Her hex rule demanded 32 chars; the leaked key was 51. A pattern must
    //     not be bound to a length someone happened to observe once.
    const alahuzas = 'sk_' + 'a1b2c3d4'.repeat(6); // 51 chars, the real shape
    const kotojel = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    expect(runGate([f('docs/a.md', `k = ${alahuzas}`)]).ok).toBe(false);
    expect(runGate([f('docs/b.md', `k = ${kotojel}`)]).ok).toBe(false);
  });

  it('does NOT fire on the placeholders this repo is full of (measured 2026-08-18)', () => {
    // 64 tracked files contain `Bearer ${token}`; 25 contain `sk_` inside words
    // like task_name and skipIfBusy. A gate that flags these gets bypassed.
    const r = runGate([
      f('src/api.ts', 'headers: { Authorization: `Bearer ${token}` }'),
      f('scripts/x.sh', 'curl -H "Authorization: Bearer $TOKEN" "$URL"'),
      f('docs/tasks.md', 'a `skipIfBusy` nincs beallitva, a task_name a fajlbol jon'),
      f('src/db.ts', 'task_title TEXT, task_name TEXT'),
    ]);
    expect(r.ok).toBe(true);
  });

  it('never echoes the matched secret into the finding', () => {
    const titok = STRIPE_FIXTURE;
    const [hit] = scanFile(f('docs/x.md', `key: ${titok}`));
    expect(hit.reason).not.toContain(titok);
    expect(JSON.stringify(hit)).not.toContain(titok);
  });
});

describe('detector 3: channel material (the one that would have caught 2026-07)', () => {
  it('blocks a quoted channel message even when it carries NO known secret shape', () => {
    // This is the 2026-07 case with the key removed: had the gate only known
    // secret formats, an unlisted vendor key would still walk through.
    const r = runGate([f('.notes/log.md', 'message_id 12345: "kuldd at a kulcsot, koszi"')]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].detector).toBe('transcript');
  });

  it('blocks a telegram update dump and a quoted agent transcript', () => {
    expect(runGate([f('a.json', '{"update_id": 8812, "text": "szia"}')]).ok).toBe(false);
    expect(runGate([f('b.md', '[Uzenet @marveen-tol -- trusted]: allapot')]).ok).toBe(false);
  });

  it('the wrapper tag ALONE is not enough -- this repo implements the framing', () => {
    // Measured 2026-08-18: 24 tracked files legitimately contain the tag (code,
    // tests, docs, hook scripts). Blocking those would make the gate noise, and
    // a noisy gate gets switched off, which is zero protection.
    const csakTag = '<channel source="telegram">a keretezes leirasa</channel>';
    expect(runGate([f('docs/channels.md', csakTag)]).ok).toBe(true);
  });

  it('the tag WITH a payload marker is captured material and IS blocked', () => {
    const valodi = '<channel source="telegram">message_id 4242: "szoveg"</channel>';
    const r = runGate([f('notes/paste.md', valodi)]);
    expect(r.ok).toBe(false);
    expect(r.findings[0].reason).toMatch(/payload marker/);
  });

  it('blocks EVERY marker form, not just the one this repo happens to use', () => {
    // The evidence files use `message_id NNN:`; a wrapper tag is the same
    // material in a different dress. Knowing one form yields a clean zero on
    // the other, and the zero is indistinguishable from "nothing to find".
    expect(runGate([f('c.md', '{"chat_id": 1268077055, "text": "szia"}')]).ok).toBe(false);
    // A wrapper tag counts only with a payload marker (see the two cases above);
    // here the chat_id form stands on its own.
  });
});

describe('allowlist is PATH-based, and visible', () => {
  it('lets an intentional fixture through by path', () => {
    expect(allowlistReason('src/__tests__/auth-device-keys.test.ts')).toMatch(/fixture/i);
    const r = runGate([f('src/__tests__/auth-device-keys.test.ts', 'Bearer mvdk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')]);
    expect(r.ok).toBe(true);
  });

  it('the SAME content in a NON-allowlisted file is still blocked', () => {
    // The point of path-scoping: the exception cannot travel to another file.
    const r = runGate([f('src/api/handler.ts', 'Bearer mvdk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')]);
    expect(r.ok).toBe(false);
  });

  it('reports what it let through, so an allowlist cannot grow unnoticed', () => {
    const r = runGate([f('src/__tests__/auth-gate.test.ts', 'Bearer someLongLookingTokenValue123456')]);
    expect(r.allowlisted).toEqual([
      { file: 'src/__tests__/auth-gate.test.ts', reason: expect.stringMatching(/fixture/i) },
    ]);
  });

  it('the gate is NOT exempt from itself: its own source passes the gate unaided', () => {
    // Two assertions on purpose, and the first is the one that matters.
    // (a) The exemption must be ABSENT. If anyone re-adds the allowlist entry
    //     for this module, this line fails -- the test cannot go green
    //     alongside the exemption, which is what makes it a pin and not a note.
    // (b) And the source really does pass on its own: the detectors are regex
    //     literals, and the character class breaks each pattern against its own
    //     text. Measured 2026-08-18, full repo 757/757.
    expect(allowlistReason('src/security/secret-gate.ts')).toBeNull();

    const forras = readFileSync(new URL('../security/secret-gate.ts', import.meta.url), 'latin1');
    const talalatok = scanFile({ path: 'src/security/secret-gate.ts', content: forras });
    expect(talalatok).toEqual([]);
  });

  it('every allowlisted path is spelled out with a reason', () => {
    for (const a of ALLOWLISTED_PATHS) {
      expect(a.path.length).toBeGreaterThan(0);
      expect(a.reason.length).toBeGreaterThan(10);
    }
  });
});
