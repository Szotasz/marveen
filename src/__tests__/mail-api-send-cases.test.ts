import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { isSendInvocation, scriptRunSends } from '../../scripts/email-send-gate.mjs'

// MAILGATEHTTPAPI1027: an HTTP mail API send (Gmail REST or client, Resend, SendGrid,
// Mailgun, Postmark) in a script file or a -e / -c code string is a send. The case list
// is shared with the main agent's python twin (scripts/__tests__/mail-api-send-cases.test.py),
// so the two gates cannot drift apart on it.

type Case = { name: string; file: string; body: string; expected: boolean; helpers?: Record<string, string>; file_only?: boolean }
const { cases } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'scripts', 'hooks', 'mail-api-send-cases.json'), 'utf-8'),
) as { cases: Case[] }

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
