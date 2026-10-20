import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, isSendInvocation, scriptRunSends } from '../../scripts/email-send-gate.mjs'

// SCRIPTSENDGATE1020: the sub-agent hard gate recognised a Python sender only
// by the file name send.py, so a self-written SMTP script under any other name
// (`python3 helden_send.py --to x@y.hu < body.txt`) went straight through.
// The narrowing lives in gateDecision only, NOT in isSendInvocation: that
// function is the shared contract with the main agent's python gates, where
// the owner's single chat approval is the rule.

const SMTP_SCRIPT = [
  'import argparse, smtplib',
  'from email.message import EmailMessage',
  'with smtplib.SMTP("mail.example.invalid", 587) as s:',
  '    s.send_message(EmailMessage())',
].join('\n')
// telethon's client.send_message is a Telegram call, not a mail: no SMTP import
const TELETHON_SCRIPT = [
  'from telethon import TelegramClient',
  'client = TelegramClient("s", 1, "h")',
  'client.send_message("me", "__wd_ping")',
].join('\n')

function workdir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'script-send-gate-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const bash = (command: string, cwd: string) => gateDecision('Bash', { command }, null, cwd)

describe('a sender script under any name (SCRIPTSENDGATE1020)', () => {
  it('denies an interpreter-run script given an address after --to/--cc/--bcc, file or no file', () => {
    const cwd = workdir({})
    for (const cmd of [
      'python3 helden_send.py --to a@example.invalid --subject X --attach f.pdf < body.txt',
      'python3 /nowhere/x.py --to=a@example.invalid',
      'python3.12 -u x.py --cc b@example.invalid',
      'python3 x.py --subject S --bcc c@example.invalid',
      'node mailer.mjs --to a@example.invalid',
    ]) {
      const v = bash(cmd, cwd)
      expect(v.deny, cmd).toBe(true)
      expect(v.kind, cmd).toBe('script-send')
    }
  })

  it('denies a script whose file uses an SMTP library, resolved against the session cwd', () => {
    const cwd = workdir({ 'helden_send.py': SMTP_SCRIPT, 'aio.py': 'import aiosmtplib\n', 'y.py': 'import yagmail\n' })
    for (const cmd of [
      'python3 helden_send.py < body.txt',
      `python3 ${join(cwd, 'helden_send.py')}`,
      'python3 -I aio.py',
      'timeout 60 python3 y.py',
      'cd /tmp && python3 helden_send.py',
      './helden_send.py',
    ]) {
      expect(bash(cmd, cwd).deny, cmd).toBe(true)
    }
  })

  it('denies a node script that uses nodemailer', () => {
    const cwd = workdir({ 'm.mjs': "import nodemailer from 'nodemailer'\n" })
    expect(bash('node m.mjs', cwd).deny).toBe(true)
    expect(bash('tsx m.mjs', cwd).deny).toBe(true)
  })

  it('lets through what is not a mail send', () => {
    const cwd = workdir({
      'prober.py': TELETHON_SCRIPT,
      'kreta_heti.py': 'print("weekly page")\n',
      'plain.mjs': 'console.log(1)\n',
      'notes.txt': 'smtplib is mentioned here, but this is no script',
    })
    for (const cmd of [
      'python3 prober.py',
      // a Telegram chat id after --to is no address
      'python3 kreta_heti.py --to 8224042443',
      'python3 ncore.py search "x" --top 40 --json',
      'python3 missing.py',
      'node plain.mjs',
      'cat notes.txt',
      'grep -rn smtplib scripts/',
      'python3 -c "print(1)"',
    ]) {
      expect(bash(cmd, cwd).deny, cmd).toBe(false)
    }
  })

  it('stays out of isSendInvocation, the contract shared with the main agent gates', () => {
    const cwd = workdir({ 'helden_send.py': SMTP_SCRIPT })
    const cmd = 'python3 helden_send.py --to a@example.invalid < body.txt'
    expect(isSendInvocation(cmd)).toBe(false)
    expect(scriptRunSends(cmd, cwd)).toBe(true)
  })

  it('the hook entrypoint resolves the script against the payload cwd', () => {
    const cwd = workdir({ 'helden_send.py': SMTP_SCRIPT })
    const hook = join(__dirname, '..', '..', 'scripts', 'email-send-gate.mjs')
    const run = (command: string) => spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
      encoding: 'utf-8', timeout: 15_000,
    })
    const sent = run('python3 helden_send.py')
    expect(sent.status).toBe(0)
    expect(JSON.parse(sent.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    const other = run('python3 other.py')
    expect(other.status).toBe(0)
    expect(other.stdout).toBe('')
  })
})
