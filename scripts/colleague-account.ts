#!/usr/bin/env tsx
// Colleague board accounts, from the machine itself (docs/board-access.md, "Colleague login").
//
//   npm run colleague-account -- add <username> <personId> [--password-stdin]
//   npm run colleague-account -- reset-password <username> [--password-stdin]
//   npm run colleague-account -- disable <username>
//   npm run colleague-account -- enable <username>
//   npm run colleague-account -- remove <username>
//   npm run colleague-account -- list
//
// The same operations as the owner-only /api/colleague-accounts routes, on the
// same file (store/colleague-accounts.json) and the same session table. The
// running dashboard sees a change on the colleague's next request: a reset or a
// disable bumps the account's generation, which ends its open sessions.
// Passwords are read interactively (twice, muted) or from stdin with
// --password-stdin; they never appear in argv or in the output.

import { initDatabase, logConfigChange } from '../src/db.js'
import { assertPasswordPolicy, PasswordPolicyError } from '../src/web/password-hash.js'
import { promptHidden } from '../src/hidden-prompt.js'
import { readBoardAccess } from '../src/web/board-access.js'
import {
  ColleagueAccountError, createColleagueAccount, deleteColleagueAccount, listColleagueAccounts,
  normaliseUsername, resetColleaguePassword, setColleagueDisabled,
} from '../src/web/colleague-accounts.js'
import { revokeColleagueSessionsFor } from '../src/web/colleague-sessions.js'

function usage(): never {
  process.stderr.write(
    'Usage:\n' +
    '  colleague-account add <username> <personId> [--password-stdin]\n' +
    '  colleague-account reset-password <username> [--password-stdin]\n' +
    '  colleague-account disable <username>\n' +
    '  colleague-account enable <username>\n' +
    '  colleague-account remove <username>\n' +
    '  colleague-account list\n',
  )
  process.exit(2)
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data.replace(/\n$/, '')))
  })
}

async function acquirePassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const pw = (await readStdin()).trim()
    assertPasswordPolicy(pw)
    return pw
  }
  const a = await promptHidden('New password: ')
  const b = await promptHidden('Repeat password: ')
  if (a !== b) {
    process.stderr.write('Passwords do not match.\n')
    process.exit(1)
  }
  assertPasswordPolicy(a)
  return a
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd) usage()
  const fromStdin = rest.includes('--password-stdin')
  const positional = rest.filter((a) => !a.startsWith('--'))
  initDatabase()

  switch (cmd) {
    case 'add': {
      const [username, person] = positional
      if (!username || !person) usage()
      const cfg = readBoardAccess()
      const pw = await acquirePassword(fromStdin)
      const a = await createColleagueAccount({ username, person, password: pw }, (pid) => !cfg.broken && cfg.people.has(pid))
      logConfigChange('colleague-account:create', null, `${a.username} -> ${a.person}`, 'cli')
      process.stdout.write(`Created colleague account "${a.username}" for board person "${a.person}".\n`)
      if (!cfg.enabled) process.stdout.write('Note: store/board-access.json has "enabled" off; the account cannot sign in until it is on.\n')
      break
    }
    case 'reset-password': {
      const [username] = positional
      if (!username) usage()
      const pw = await acquirePassword(fromStdin)
      const a = await resetColleaguePassword(username, pw)
      revokeColleagueSessionsFor(a.username)
      logConfigChange('colleague-account:password', null, a.username, 'cli')
      process.stdout.write(`Password reset for "${a.username}"; its sessions were ended.\n`)
      break
    }
    case 'disable':
    case 'enable': {
      const [username] = positional
      if (!username) usage()
      const a = setColleagueDisabled(username, cmd === 'disable')
      if (cmd === 'disable') revokeColleagueSessionsFor(a.username)
      logConfigChange(`colleague-account:${cmd}`, null, a.username, 'cli')
      process.stdout.write(`${cmd === 'disable' ? 'Disabled' : 'Enabled'} "${a.username}".\n`)
      break
    }
    case 'remove': {
      const [username] = positional
      if (!username) usage()
      deleteColleagueAccount(username)
      const u = normaliseUsername(username)
      if (u) revokeColleagueSessionsFor(u)
      logConfigChange('colleague-account:delete', u, null, 'cli')
      process.stdout.write(`Removed "${u}".\n`)
      break
    }
    case 'list': {
      const list = listColleagueAccounts()
      if (list.length === 0) { process.stdout.write('No colleague accounts.\n'); break }
      for (const a of list) {
        process.stdout.write(`${a.username}  person=${a.person}${a.disabled ? '  (disabled)' : ''}  created ${new Date(a.createdAt * 1000).toISOString()}\n`)
      }
      break
    }
    default:
      usage()
  }
}

main().catch((err) => {
  if (err instanceof PasswordPolicyError || err instanceof ColleagueAccountError) {
    process.stderr.write(`${err.message}\n`)
    process.exit(1)
  }
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`)
  process.exit(1)
})
