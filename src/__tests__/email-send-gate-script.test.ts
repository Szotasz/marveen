import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
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

// First-round review of #2087 (Szotasz, 2026-10-20): two stated claims did not
// hold (an extensionless file run through its #!, an address under -m), shell
// -c strings and one level of helper modules were not seen, and the bare-word
// content match denied files that only NAME a mail library.
describe('sender scripts, review round 1 (SCRIPTSENDGATE1020)', () => {
  const NOEXT_PY = '#!/usr/bin/env python3\nimport smtplib\nsmtplib.SMTP("h")\n'

  it('reads an extensionless, directly executed file by its #! line', () => {
    const cwd = workdir({
      noext_sender: NOEXT_PY,
      node_sender: "#!/usr/bin/env -S node --no-warnings\nconst m = require('nodemailer')\n",
      py_by_path: '#!/usr/bin/python3.12\nfrom smtplib import SMTP_SSL\n',
      shell_tool: '#!/bin/sh\n# smtplib\nimport smtplib\n',
    })
    chmodSync(join(cwd, 'noext_sender'), 0o755)
    for (const cmd of ['./noext_sender', `${join(cwd, 'noext_sender')} --subject S`, './node_sender', './py_by_path']) {
      expect(bash(cmd, cwd).deny, cmd).toBe(true)
    }
    // no python/node #! line: not judged, even with the word inside
    expect(bash('./shell_tool', cwd).deny).toBe(false)
    expect(bash('/bin/ls -la', cwd).deny).toBe(false)
  })

  it('an address flag counts under python -m / -c and on a directly run file', () => {
    const cwd = workdir({ 'tool.py': 'print(1)\n' })
    for (const cmd of [
      'python3 -m pkg --to someone@example.invalid',
      'python3 -m pkg.sender --cc=someone@example.invalid',
      'python3 -c "import sys" --bcc someone@example.invalid',
      './tool.py --to someone@example.invalid',
    ]) {
      expect(bash(cmd, cwd).deny, cmd).toBe(true)
    }
    expect(bash('python3 -m pkg --to 8224042443', cwd).deny).toBe(false)
  })

  it('judges the string of a shell -c the same way', () => {
    const cwd = workdir({ 'smtp_send.py': SMTP_SCRIPT })
    for (const cmd of [
      'sh -c "python3 smtp_send.py"',
      "bash -lc 'timeout 30 python3 smtp_send.py'",
      'zsh -c "python3 -m x --to a@example.invalid"',
    ]) {
      expect(bash(cmd, cwd).deny, cmd).toBe(true)
    }
    expect(bash('sh -c "python3 other.py"', cwd).deny).toBe(false)
  })

  it('follows one level of local helper modules', () => {
    const cwd = workdir({
      'via_helper.py': 'from mailhelper import send_mail\nsend_mail()\n',
      'mailhelper.py': 'import smtplib\ndef send_mail(): pass\n',
      'via_pkg.py': 'import os, mailpkg.core as core\n',
      'mailpkg/__init__.py': '',
      'mailpkg/core.py': 'import aiosmtplib\n',
      'via_node.mjs': "import { send } from './mh.js'\n",
      'mh.js': "const nm = require('nodemailer')\n",
      'two_levels.py': 'import via_helper\n',
      'plain_helper.py': 'import json, helperless\n',
      'helperless.py': 'print(1)\n',
    })
    for (const cmd of ['python3 via_helper.py', 'python3 via_pkg.py', 'node via_node.mjs']) {
      expect(bash(cmd, cwd).deny, cmd).toBe(true)
    }
    // past the first level is a documented limit; a helper without a mail import passes
    expect(bash('python3 two_levels.py', cwd).deny).toBe(false)
    expect(bash('python3 plain_helper.py', cwd).deny).toBe(false)
  })

  it('matches an import, not a bare mention of the library', () => {
    const cwd = workdir({
      'alias.py': 'import smtplib as s\n',
      'from_import.py': 'from smtplib import SMTP_SSL\n',
      'dyn.py': 'import importlib\nm = importlib.import_module("smtplib")\n',
      'mocks.py': '# runs send.py in-process with smtplib replaced\nsend.smtplib.SMTP_SSL = object\n',
      'commented.py': 'import os  # smtplib is not used here\n',
      'regex.mjs': 'const R = /\\bnodemailer\\b/\n// the fork tests import nodemailer\n',
      'dyn.mjs': "const nm = await import('nodemailer')\n",
    })
    for (const cmd of ['python3 alias.py', 'python3 from_import.py', 'python3 dyn.py', 'node dyn.mjs']) {
      expect(bash(cmd, cwd).deny, cmd).toBe(true)
    }
    for (const cmd of ['python3 mocks.py', 'python3 commented.py', 'node regex.mjs']) {
      expect(bash(cmd, cwd).deny, cmd).toBe(false)
    }
  })

  it('no longer denies the repo files that only name a mail library', () => {
    const repo = join(__dirname, '..', '..')
    for (const cmd of [
      'node scripts/email-send-gate.mjs',
      'python3 scripts/__tests__/support-mail-rcpt-list.test.py',
      'tsx vitest.config.ts',
    ]) {
      expect(bash(cmd, repo).deny, cmd).toBe(false)
    }
  })
})

describe('Microsoft Graph sends in a script (MAILGATESCRIPT1027)', () => {
  const GRAPH_SEND = "const id = process.argv[2]\nawait fetch('https://graph.microsoft.com/v1.0/me/messages/' + id + '/send', { method: 'POST' })\n"
  const GRAPH_REPLY = "const u = 'x'\nawait fetch(`https://graph.microsoft.com/v1.0/users/${u}/messages/1/reply`, { method: 'POST' })\n"
  const GRAPH_READ = "await fetch('https://graph.microsoft.com/v1.0/me/messages?top=5')\n"
  const cwd = workdir({
    'graph-send.mjs': GRAPH_SEND,
    'graph-reply.ts': GRAPH_REPLY,
    'graph-read.mjs': GRAPH_READ,
    'harmless.mjs': "console.log('hello')\n",
    'main.mjs': "import './lib.mjs'\nconsole.log('main')\n",
    'lib.mjs': "await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST' })\n",
    'reexp.mjs': "export * from './transport2.mjs'\n",
    'transport2.mjs': GRAPH_SEND,
    'escaped.mjs': 'await fetch("https:\\/\\/graph.microsoft.com\\/v1.0\\/me\\/sendMail", { method: "POST" })\n',
    'routes.mjs': "app.get('/me/messages/:id/reply', showReplyPage)\n",
    'preview.mjs': "await fetch('https://graph.microsoft.com/v1.0/me/messages/1/send-preview')\n",
    'real/main.mjs': "import './transport.mjs'\n",
    'real/transport.mjs': GRAPH_SEND,
    'link/.keep': '',
    // MAILGATESCRIPT1027 R2: fixtures of the second-round review fixes
    'r2real/main.mjs': [0, 1, 2, 3, 4].map((n) => `import './h${n}.mjs'`).join('\n') + '\n',
    'r2real/h0.mjs': "const n = require('nodemailer')\n",
    'r2real/h1.mjs': 'console.log(1)\n',
    'r2real/h2.mjs': 'console.log(1)\n',
    'r2real/h3.mjs': 'console.log(1)\n',
    'r2real/h4.mjs': 'console.log(1)\n',
    'r2link/.keep': '',
    'r2types.ts': "export type { T } from './r2sender.mjs'\nimport type { U } from './r2sender.mjs'\nconsole.log(1)\n",
    'r2sender.mjs': GRAPH_SEND,
    'r2uni.mjs': "await fetch('https://graph.microsoft.com/v1.0/me/messages/1/reply\u00e9')\n",
    'r2pkg/__init__.py': '',
    'r2pkg/__main__.py': 'from . import mailer\n',
    'r2pkg/mailer.py': 'import smtplib\n',
    'r3esc.mjs': 'const u = "https://graph.microsoft.com/v1.0/me/sendMail\\"; await fetch(u)\n',
    'r3sender.mjs': "import nodemailer from 'nodemailer'\nexport default 1\n",
    'r3typedefault.mjs': "import type from './r3sender.mjs'\nvoid type\n",
    'r3mailer.py': 'import smtplib\n',
    'r3star.py': 'from r3mailer import *\n',
  })
  symlinkSync(join(cwd, 'real', 'main.mjs'), join(cwd, 'link', 'main.mjs'))
  symlinkSync(join(cwd, 'r2real', 'main.mjs'), join(cwd, 'r2link', 'main.mjs'))

  it('is a send for a node file, a .ts file and a file whose helper sends', () => {
    for (const cmd of ['node graph-send.mjs AAMk1', 'tsx graph-reply.ts', 'node main.mjs']) {
      expect(scriptRunSends(cmd, cwd), cmd).toBe(true)
    }
  })

  it('is no send for a Graph read or a harmless file', () => {
    for (const cmd of ['node graph-read.mjs', 'node harmless.mjs']) {
      expect(scriptRunSends(cmd, cwd), cmd).toBe(false)
    }
  })

  it('reads the script after bun run and npx tsx, and not after another npx package', () => {
    expect(scriptRunSends('bun run graph-send.mjs', cwd)).toBe(true)
    expect(scriptRunSends('npx tsx graph-send.mjs', cwd)).toBe(true)
    expect(scriptRunSends('npx vitest run', cwd)).toBe(false)
  })

  it('follows an ESM re-export to the helper', () => {
    expect(scriptRunSends('node reexp.mjs', cwd)).toBe(true)
  })

  it('sees a Graph URL with escaped slashes', () => {
    expect(scriptRunSends('node escaped.mjs', cwd)).toBe(true)
  })

  it('is no send for an application route of the same shape or for send-preview', () => {
    expect(scriptRunSends('node routes.mjs', cwd)).toBe(false)
    expect(scriptRunSends('node preview.mjs', cwd)).toBe(false)
  })

  it('resolves helpers next to the real path of a symlinked entry', () => {
    expect(scriptRunSends('node link/main.mjs', cwd)).toBe(true)
  })

  // MAILGATESCRIPT1027 R2
  it('reads the real-path helpers of a symlinked entry with five imports', () => {
    expect(scriptRunSends('node r2link/main.mjs', cwd)).toBe(true)
  })

  it('loads nothing for a type-only export or import', () => {
    expect(scriptRunSends('tsx r2types.ts', cwd)).toBe(false)
  })

  it('ends no action word at a letter outside ASCII', () => {
    expect(scriptRunSends('node r2uni.mjs', cwd)).toBe(false)
    // MAILGATESCRIPT1027 R3: the forms the round-2 commit lost, and a value import named `type`
    expect(scriptRunSends('node r3esc.mjs', cwd)).toBe(true)
    expect(scriptRunSends('node r3typedefault.mjs', cwd)).toBe(true)
    expect(scriptRunSends('python3 r3star.py', cwd)).toBe(true)
  })

  it('follows a package-relative python import', () => {
    expect(scriptRunSends(`python3 ${cwd}/r2pkg/__main__.py`, cwd)).toBe(true)
  })

  it('is no script run for npx with another package, even with an address', () => {
    expect(scriptRunSends('npx harmless-report --to qa@example.test', cwd)).toBe(false)
  })
})
