import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// GATEBINVAK916: the copy gate never read curl's `@file` payload.
//
// MEASURED 2026-09-23, before this change, on BOTH the develop tree and the
// live installed hook:
//   - Resend send with `--data-binary @letter.json` -> BLOCKED, clean letter
//     included, reason "a hook nem talalt vizsgalhato szoveget". Not a silent
//     pass as the card assumed, but the letter was never audited, and the
//     acceptance criterion "a clean payload goes through" failed.
//   - inter-agent `curl .../api/messages` -> NOT a send invocation at all,
//     heredoc AND @file alike (pinned expected:false in
//     send-invocation-cases.json). The @ branch does not change that; whether
//     inter-agent traffic gets a homoglyph check is a separate scope decision.
//
// Card acceptance: (a) homoglyph in an @file JSON payload BLOCKS, for its
// content; (b) a clean one PASSES; (c) an unreadable @path gives a "cannot
// see" reason, not a silent empty.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
const EXTRACT = join(ROOT, 'scripts', 'hooks', 'email_extract.py')

// Built from code points so this file never carries a literal lookalike.
const CYR_A = String.fromCodePoint(0x430)
const CLEAN = 'Szia, küldöm a számlát, kérlek nézd meg, köszönöm.'
const HOMO = `Szia, küldöm a számlát, kérlek nézd meg, köszönöm, k${CYR_A}pcsolat.`

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gatebinvak-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function file(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

function gate(cmd: string): { code: number | null; err: string } {
  const r = spawnSync('python3', [GATE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, hook_event_name: 'PreToolUse' }),
    encoding: 'utf-8',
    // Rules path (and so the gate's log) inside the test dir: hermetic, and
    // never a write into the checkout's store/.
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, OUTGOING_COPY_GATE_RULES: join(dir, 'rules.json') },
  })
  return { code: r.status, err: r.stderr }
}

function extract(cmd: string): [string, string | null] {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("ex", ${JSON.stringify(EXTRACT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.collect_bash_body(sys.argv[1])))
`, cmd], { encoding: 'utf-8' })
  return JSON.parse(out.trim())
}

const resend = (flagAndPath: string) =>
  `curl -s -X POST https://api.resend.com/emails -H 'Authorization: Bearer x' -H 'Content-Type: application/json' ${flagAndPath}`

describe('copy gate reads a curl @file payload (GATEBINVAK916)', () => {
  it('(a) a homoglyph in an @file JSON letter BLOCKS, for its CONTENT', () => {
    // ensure_ascii JSON on purpose: the file holds \u escapes, the audit must
    // read the decoded letter.
    const p = file('homo.json', JSON.stringify({ to: 'c@d.hu', subject: 'Számla', text: HOMO }).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
    const r = gate(resend(`--data-binary @${p}`))
    expect(r.code).toBe(2)
    expect(r.err).toContain('homoglifa')
    expect(r.err).not.toContain('nem talalt vizsgalhato szoveget')
  })

  it('(b) a clean @file JSON letter PASSES', () => {
    const p = file('clean.json', JSON.stringify({ to: 'c@d.hu', subject: 'Számla', text: CLEAN }))
    expect(gate(resend(`--data-binary @${p}`)).code).toBe(0)
  })

  it('(c) an unreadable @path is a "cannot see" reason, never a silent empty', () => {
    const missing = join(dir, 'nincs-ilyen.json')
    const [text, reason] = extract(resend(`--data-binary @${missing}`))
    expect(text).toBe('')
    expect(reason).toMatch(/nem olvashato/)
    expect(reason).toContain(missing)
    const r = gate(resend(`--data-binary @${missing}`))
    expect(r.code).toBe(2)
    expect(r.err).toContain('nem olvashato')
  })

  it('every curl data flag that reads a file is recognised, in every spelling', () => {
    const p = file('plain.txt', CLEAN)
    for (const shape of [`-d @${p}`, `-d@${p}`, `--data @${p}`, `--data-binary=@${p}`, `--json @${p}`, `--data-ascii @${p}`, `--data-urlencode @${p}`, `--data-binary '@${p}'`, `--data-binary "@${p}"`]) {
      expect(extract(resend(shape)), shape).toEqual([CLEAN, null])
    }
  })

  it('--data-raw is NOT a file read (curl sends the literal "@path")', () => {
    const p = file('raw.txt', CLEAN)
    expect(extract(resend(`--data-raw @${p}`))).toEqual(['', null])
  })

  it('an @ in an address or a quoted payload is never taken for a file', () => {
    expect(extract(`curl -s https://api.resend.com/emails --to a@b.hu -H 'X: y@z'`)).toEqual(['', null])
  })

  it('a shell-expanded @path is unreadable (fail-closed), like the < branch', () => {
    const [, reason] = extract(resend('--data-binary @$HOME/$LETTER.json'))
    expect(reason).toMatch(/fel nem oldhato utvonal.*@\$HOME/)
  })

  it('@- without a heredoc is unreadable; @- WITH a heredoc reads the heredoc', () => {
    expect(extract(`cat letter.json | ${resend('--data-binary @-')}`)[1]).toMatch(/stdin/)
    expect(extract(`${resend('--data-binary @-')} <<'JSON'\n${CLEAN}\nJSON`)).toEqual([CLEAN, null])
  })

  it('a JSON payload with no prose field is unreadable, not silently empty', () => {
    const p = file('noprose.json', JSON.stringify({ to: 'c@d.hu', template_id: 42 }))
    expect(extract(resend(`--data-binary @${p}`))[1]).toMatch(/nincs ismert szoveg-mezo/)
    const arr = file('arr.json', JSON.stringify([CLEAN]))
    expect(extract(resend(`--data-binary @${arr}`))[1]).toMatch(/nem objektum/)
  })

  it('a non-JSON @file is the text itself', () => {
    const p = file('letter.txt', CLEAN)
    expect(extract(resend(`--data-binary @${p}`))).toEqual([CLEAN, null])
  })

  // Marveen's #1507 review: five more shapes send a FILE as the body. Before
  // this they fell to the generic "no inspectable text" -- the very message
  // this change retires -- and `--data-urlencode name@file` LOOKED handled.
  const FIVE = (p: string): Array<[string, string]> => [
    ['--data-urlencode name@', resend(`--data-urlencode text@${p}`)],
    ['-F name=@', resend(`-F "text=@${p};type=text/plain"`)],
    ['-F name=<', resend(`-F "text=<${p}"`)],
    ['wget --post-file', `wget --post-file=${p} https://api.resend.com/emails`],
    ['wget --body-file', `wget --method=POST --body-file ${p} https://api.resend.com/emails`],
    ['curl -T', resend(`-T ${p}`)],
    ['curl --upload-file', resend(`--upload-file ${p}`)],
  ]

  it('the five further file-body shapes are READ: clean passes, homoglyph blocks for its content', () => {
    const clean = file('five-clean.txt', CLEAN)
    const homo = file('five-homo.txt', HOMO)
    for (const [label, cmd] of FIVE(clean)) {
      expect(extract(cmd), label).toEqual([CLEAN, null])
      expect(gate(cmd).code, label).toBe(0)
    }
    for (const [label, cmd] of FIVE(homo)) {
      const r = gate(cmd)
      expect(r.code, label).toBe(2)
      expect(r.err, label).toContain('homoglifa')
    }
  })

  it('an unreadable file in any of them gets a NAMED reason, never the generic one', () => {
    const missing = join(dir, 'five-missing.txt')
    for (const [label, cmd] of FIVE(missing)) {
      const [text, reason] = extract(cmd)
      expect(text, label).toBe('')
      expect(reason, label).toMatch(/nem olvashato/)
      const r = gate(cmd)
      expect(r.code, label).toBe(2)
      expect(r.err, label).not.toContain('nem talalt vizsgalhato szoveget')
    }
  })

  it('an UNQUOTED -F name=<file (a shell redirect too) is read once, not twice', () => {
    const p = file('once.txt', CLEAN)
    expect(extract(resend(`-F text=<${p}`))).toEqual([CLEAN, null])
  })

  it('--form-string stays a literal (no file is read)', () => {
    const p = file('fs.txt', CLEAN)
    expect(extract(resend(`--form-string "text=@${p}"`))).toEqual(['', null])
  })

  // Inter-agent messages stay out of the EMAIL gate. Since INTERAGENTHOMOGLIF923
  // (#1509) they get their own homoglyph-only check, so a lookalike in an @file
  // message now blocks -- but on the inter-agent branch, not on the email rules,
  // and accentless text (which the email accent rule would stop) still passes.
  // Before #1509 this case pinned "passes"; merged together the two went red.
  it('inter-agent messages stay out of the email gate: only the homoglyph check runs', () => {
    const post = (p: string) =>
      `curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" --data-binary @${p}`
    const homo = gate(post(file('msg.json', JSON.stringify({ from: 'samu', to: 'marveen', content: HOMO }))))
    expect(homo.code).toBe(2)
    expect(homo.err).toMatch(/\(inter-agent\)/)
    const accentless = gate(post(file('msg2.json', JSON.stringify({ from: 'samu', to: 'marveen', content: 'Szia, kuldom a szamlat, nezd meg.' }))))
    expect(accentless.code).toBe(0)
    // Control: the SAME accentless text as an email letter is stopped by the
    // email rules, so the pass above is the scope, not a toothless gate.
    const asMail = gate(resend(`--data-binary @${file('mail2.json', JSON.stringify({ to: 'c@d.hu', subject: 'Szamla', text: 'Szia, kuldom a szamlat, nezd meg.' }))}`))
    expect(asMail.code).toBe(2)
  })
})
