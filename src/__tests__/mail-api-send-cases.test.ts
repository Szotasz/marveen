import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { isSendInvocation, scriptRunSends } from '../../scripts/email-send-gate.mjs'

// MAILGATEHTTPAPI1027: an HTTP mail API send (Gmail REST or client, Resend, SendGrid,
// Mailgun, Postmark) in a script file or a -e / -c code string is a send. The case list
// is shared with the main agent's python twin (scripts/__tests__/mail-api-send-cases.test.py),
// so the two gates cannot drift apart on it.

type Case = { name: string; file: string; body: string; expected: boolean; helpers?: Record<string, string>; file_only?: boolean }
type InlineCase = { name: string; cmd: string; expected: boolean }
type UrlFileCase = InlineCase & { class: 'send' | 'allow' | 'undecidable'; files: Record<string, string> }
const { cases, inline, url_file: urlFile } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'mail-api-send-cases.json'), 'utf-8'),
) as { cases: Case[]; inline: InlineCase[]; url_file: UrlFileCase[] }

// The same quoting as python's shlex.quote, so both twins judge the identical command.
const shQuote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`
const progFor = (file: string) => (file.endsWith('.py') ? 'python3' : 'node')

describe('HTTP mail API sends (MAILGATEHTTPAPI1027)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mail-api-send-'))
  for (const c of cases) {
    writeFileSync(join(cwd, c.file), c.body)
    for (const [name, body] of Object.entries(c.helpers ?? {})) writeFileSync(join(cwd, name), body)
  }

  it('the shared list has send and no-send cases', () => {
    expect(cases.some((c) => c.expected)).toBe(true)
    expect(cases.some((c) => !c.expected)).toBe(true)
  })

  it.each(cases)('script file: $name', (c) => {
    expect(scriptRunSends(`${progFor(c.file)} ${c.file}`, cwd)).toBe(c.expected)
  })

  it.each(cases.filter((c) => !c.helpers && !c.file_only))('code string: $name', (c) => {
    const prog = progFor(c.file)
    const flag = prog === 'python3' ? '-c' : '-e'
    expect(isSendInvocation(`${prog} ${flag} ${shQuote(c.body)}`)).toBe(c.expected)
  })
})

// MAILCURLSEND1118: an HTTP mail API send written inline on the command line is judged like the same send in a script.
describe('HTTP mail API sends written inline on the command line (MAILCURLSEND1118)', () => {
  it('the inline list has send and no-send cases', () => {
    expect(inline.some((c) => c.expected)).toBe(true)
    expect(inline.some((c) => !c.expected)).toBe(true)
  })

  it.each(inline)('inline command: $name', (c) => {
    expect(isSendInvocation(c.cmd)).toBe(c.expected)
  })
})

// MAILURLFILE1118: a request whose URL comes from a file the line names is judged with the file read in.
describe('HTTP mail API sends whose URL comes from a file the line names (MAILURLFILE1118)', () => {
  it('the url_file list has every class, and undecidable both ways', () => {
    expect(new Set(urlFile.map((c) => c.class))).toEqual(new Set(['send', 'allow', 'undecidable']))
    expect(urlFile.filter((c) => c.class !== 'undecidable').every((c) => c.expected === (c.class === 'send'))).toBe(true)
    expect(new Set(urlFile.filter((c) => c.class === 'undecidable').map((c) => c.expected))).toEqual(new Set([true, false]))
  })

  it.each(urlFile)('url file ($class): $name', (c) => {
    const cwd = mkdtempSync(join(tmpdir(), 'mail-url-file-'))
    for (const [name, body] of Object.entries(c.files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true })
      writeFileSync(join(cwd, name), body)
    }
    expect(isSendInvocation(c.cmd.replaceAll('{dir}', cwd), 0, cwd)).toBe(c.expected)
  })
})
