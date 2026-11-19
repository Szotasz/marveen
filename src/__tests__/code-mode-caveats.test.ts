// CODEMODEFLAG1119 (Q2, Samu 81017): the caveat keys in an agent's isolated .claude.json. "on" sets both true, "off"
// removes both, and off -> on -> off gives the ORIGINAL BYTES back (Claude Code owns the file; the dashboard must not
// reformat it). The shared ~/.claude.json is never written.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { codeModeCaveatsText, setCodeModeCaveats, CODE_MODE_CAVEAT_KEYS } from '../web/code-mode-caveats.js'

const tmp = mkdtempSync(join(tmpdir(), 'code-mode-caveats-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// The shape Claude Code writes: two-space JSON with nested objects and a trailing newline.
const ORIGINAL = '{\n  "numStartups": 12,\n  "hasCompletedOnboarding": true,\n  "projects": {\n    "/Users/x/agents/abel": {\n      "hasTrustDialogAccepted": true\n    }\n  },\n  "oauthAccount": {\n    "accountUuid": "a"\n  }\n}\n'
const [K1, K2] = CODE_MODE_CAVEAT_KEYS

describe('codeModeCaveatsText', () => {
  it('the key names are the ones the probe config dir holds after answering the dialog', () => {
    expect(CODE_MODE_CAVEAT_KEYS).toEqual(['codeModeCaveatsAcceptedV1', 'codeModeAutoModeCaveatAcceptedV1'])
  })

  it('on: both keys true, every other value kept', () => {
    const on = codeModeCaveatsText(ORIGINAL, true)!
    expect(JSON.parse(on)).toEqual({ ...JSON.parse(ORIGINAL), [K1]: true, [K2]: true })
  })

  it('off -> on -> off: the original bytes come back', () => {
    const on = codeModeCaveatsText(ORIGINAL, true)!
    expect(codeModeCaveatsText(on, false)).toBe(ORIGINAL)
  })

  it('a shape a JSON rewrite would change (no trailing newline, compact) also comes back byte-identical', () => {
    for (const text of [ORIGINAL.trimEnd(), '{"a":1,"b":{"c":[1,2]}}']) {
      const on = codeModeCaveatsText(text, true)!
      expect(JSON.parse(on)).toEqual({ ...JSON.parse(text), [K1]: true, [K2]: true })
      expect(codeModeCaveatsText(on, false)).toBe(text)
    }
  })

  it('nothing to do -> null (on twice, off on a file without the keys)', () => {
    expect(codeModeCaveatsText(codeModeCaveatsText(ORIGINAL, true)!, true)).toBeNull()
    expect(codeModeCaveatsText(ORIGINAL, false)).toBeNull()
  })

  it('a key present with another value is set true; off removes it too', () => {
    const withFalse = ORIGINAL.replace('{\n', `{\n  "${K1}": false,\n`)
    const on = codeModeCaveatsText(withFalse, true)!
    expect(JSON.parse(on)[K1]).toBe(true)
    expect(JSON.parse(on)[K2]).toBe(true)
    expect(JSON.parse(codeModeCaveatsText(on, false)!)).toEqual(JSON.parse(ORIGINAL))
  })

  it('an empty object and a file Claude Code reformatted (keys last, no comma) still give valid JSON', () => {
    expect(JSON.parse(codeModeCaveatsText('{}', true)!)).toEqual({ [K1]: true, [K2]: true })
    const reformatted = JSON.stringify({ a: 1, [K1]: true, [K2]: true }, null, 2)
    expect(JSON.parse(codeModeCaveatsText(reformatted, false)!)).toEqual({ a: 1 })
  })

  it('a file that is not a JSON object throws (the caller leaves it alone)', () => {
    expect(() => codeModeCaveatsText('{broken', true)).toThrow()
    expect(() => codeModeCaveatsText('[]', true)).toThrow()
  })
})

describe('setCodeModeCaveats', () => {
  it('writes on, removes off, keeps the file mode, and off -> on -> off is byte-identical on disk', () => {
    const p = join(tmp, 'a.json')
    writeFileSync(p, ORIGINAL)
    chmodSync(p, 0o600)
    expect(setCodeModeCaveats(p, true)).toBe('written')
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(setCodeModeCaveats(p, true)).toBe('unchanged')
    expect(setCodeModeCaveats(p, false)).toBe('written')
    expect(readFileSync(p, 'utf-8')).toBe(ORIGINAL)
    expect(setCodeModeCaveats(p, false)).toBe('unchanged')
  })

  it('a per-user agent keeps group access', () => {
    const p = join(tmp, 'g.json')
    writeFileSync(p, ORIGINAL)
    chmodSync(p, 0o600)
    setCodeModeCaveats(p, true, { groupShared: true })
    expect(statSync(p).mode & 0o777).toBe(0o660)
  })

  it('no file: missing, nothing created', () => {
    const p = join(tmp, 'none.json')
    expect(setCodeModeCaveats(p, true)).toBe('missing')
    expect(existsSync(p)).toBe(false)
  })

  it('the shared ~/.claude.json is refused (measured on a stand-in HOME, never the real one)', () => {
    const home = join(tmp, 'home')
    mkdirSync(home)
    const shared = join(home, '.claude.json')
    writeFileSync(shared, ORIGINAL)
    const realHome = process.env.HOME
    process.env.HOME = home
    try {
      expect(homedir()).toBe(home)
      expect(setCodeModeCaveats(shared, true)).toBe('refused')
      expect(setCodeModeCaveats(shared, false)).toBe('refused')
    } finally { process.env.HOME = realHome }
    expect(readFileSync(shared, 'utf-8')).toBe(ORIGINAL)
  })
})
