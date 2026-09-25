import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  scanFileDetailed, fixtureExceptionReason, invalidFixtureExceptions,
  FIXTURE_EXCEPTIONS, type FixtureException,
} from '../security/secret-gate.js'

// A fixture exception clears ONE literal in ONE test file. These cases exist to
// prove the "one" in both halves of that sentence, because the whole reason the
// mechanism was built instead of adding two ALLOWLISTED_PATHS entries is that an
// allowlist entry blinds a whole file.
//
// The mechanism is exercised with SYNTHETIC entries. Testing it through the real
// ones would mean writing their literals here to reproduce the hashes, which
// would put the very secret-shaped strings this exists to contain into one more
// file -- and that file would then need its own exception.

/** Assembled at runtime so this test file carries no key-shaped literal. */
const KEY_A = `sk-${'A'.repeat(30)}`
const KEY_B = `sk-${'B'.repeat(30)}`
const AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`

const hash = (s: string) => createHash('sha256').update(s, 'latin1').digest('hex')

const REASON = 'a synthetic fixture whose raw-secret shape is the subject under test'
const EXC: FixtureException[] = [
  { path: 'src/__tests__/fake-fixture.test.ts', sha256: hash(KEY_A), reason: REASON },
]

describe('fixture exceptions are narrow', () => {
  it('clears the named literal in the named file', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const k = '${KEY_A}'\n` }, EXC)
    expect(r.findings).toHaveLength(0)
    expect(r.exceptions).toHaveLength(1)
    expect(r.exceptions[0].reason).toBe(REASON)
    expect(r.exceptions[0].line).toBe(1)
  })

  it('the REST of the same file is still scanned -- this is the whole point', () => {
    const content = `const ok = '${KEY_A}'\nconst notOk = '${AWS}'\n`
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content }, EXC)
    expect(r.exceptions).toHaveLength(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].reason).toContain('AWS access key id')
    expect(r.findings[0].line).toBe(2)
  })

  it('a DIFFERENT literal in the same file is not covered', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const k = '${KEY_B}'\n` }, EXC)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('the SAME literal in a different file is not covered', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/other.test.ts', content: `const k = '${KEY_A}'\n` }, EXC)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('editing the fixture invalidates its exception, so the gate goes red and a human looks', () => {
    // The hash is the point: an exception cannot drift onto text nobody approved.
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const k = '${KEY_A}X'\n` }, EXC)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('a non-test path can never carry an exception, even if the hash matches', () => {
    const prod: FixtureException[] = [{ path: 'src/costops/collectors/anthropic.ts', sha256: hash(KEY_A), reason: REASON }]
    expect(fixtureExceptionReason('src/costops/collectors/anthropic.ts', KEY_A, prod)).toBeNull()
    const r = scanFileDetailed({ path: 'src/costops/collectors/anthropic.ts', content: `const k = '${KEY_A}'\n` }, prod)
    expect(r.findings).toHaveLength(1)
    expect(r.exceptions).toHaveLength(0)
  })

  it('a malformed exception is reported rather than silently widening the gate', () => {
    expect(invalidFixtureExceptions([
      { path: 'src/costops/x.ts', sha256: hash(KEY_A), reason: REASON },
    ])[0].reason).toContain('TEST-ONLY')
    expect(invalidFixtureExceptions([
      { path: 'src/__tests__/x.test.ts', sha256: 'nothex', reason: REASON },
    ])[0].reason).toContain('64 lowercase hex')
    expect(invalidFixtureExceptions([
      { path: 'src/__tests__/x.test.ts', sha256: hash(KEY_A), reason: 'because' },
    ])[0].reason).toContain('reason')
  })

  it('the exceptions actually shipped are well formed and test-only', () => {
    expect(invalidFixtureExceptions()).toEqual([])
    for (const e of FIXTURE_EXCEPTIONS) expect(e.path).toMatch(/(^|\/)(__tests__|tests)\//)
  })
})
