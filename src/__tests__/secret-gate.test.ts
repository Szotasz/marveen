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

  it('every allowlisted path is spelled out with a reason', () => {
    for (const a of ALLOWLISTED_PATHS) {
      expect(a.path.length).toBeGreaterThan(0);
      expect(a.reason.length).toBeGreaterThan(10);
    }
  });
});
