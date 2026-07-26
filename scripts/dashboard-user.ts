#!/usr/bin/env tsx
// Dashboard browser-login user administration (break-glass + scripting).
//
//   npm run dashboard-user -- add <username> [--password-stdin]
//   npm run dashboard-user -- reset-password <username> [--password-stdin]
//   npm run dashboard-user -- list
//   npm run dashboard-user -- remove <username>
//   npm run dashboard-user -- sessions:clear [<username>]
//   npm run dashboard-user -- security:reset
//
// THIS IS THE BREAK-GLASS PATH. It talks to SQLite directly -- no HTTP, no
// auth gate -- so it works even when the web login is misconfigured, throttled
// or unreachable. The operator can always run commands on the machine hosting
// the install, so "I can run this CLI" is the root credential.
//
// security:reset is the panic lever: it revokes EVERY device key and clears
// EVERY browser session in one step (future login-enforcement toggles will be
// cleared here too). Passwords and users are untouched; the bearer token keeps
// working. See docs/dashboard-auth-recovery.md.
//
// Passwords are read interactively (twice, muted)
// or from stdin with --password-stdin for automation. No new dependencies:
// node:readline for the prompt, the app's own db + password-hash modules.

import { createInterface } from 'node:readline'
import { initDatabase, getDb, createDashboardUser, getDashboardUser, listDashboardUsers, deleteDashboardUser, updateDashboardUserPassword, logConfigChange } from '../src/db.js'
import { hashPassword, assertPasswordPolicy, PasswordPolicyError } from '../src/web/password-hash.js'
import { revokeAllForUser } from '../src/web/auth-sessions.js'
import { securityReset } from '../src/web/security-reset.js'
import { notifySecurityEvent } from '../src/notify.js'

function usage(): never {
  process.stderr.write(
    'Usage:\n' +
    '  dashboard-user add <username> [--password-stdin]\n' +
    '  dashboard-user reset-password <username> [--password-stdin]\n' +
    '  dashboard-user list\n' +
    '  dashboard-user remove <username>\n' +
    '  dashboard-user sessions:clear [<username>]\n' +
    '  dashboard-user security:reset      # revoke ALL device keys + clear ALL browser sessions\n',
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

// Muted interactive prompt: echo is suppressed so the password is not shown.
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void }
    process.stdout.write(question)
    let first = true
    out._writeToOutput = (str: string) => {
      // Let the first write (the question echo) through, mute keystrokes after.
      if (first) { first = false; process.stdout.write(str); return }
      // Print nothing for typed characters; keep newlines so Enter works.
      if (str.includes('\n')) process.stdout.write('\n')
    }
    rl.question('', (answer) => {
      out._writeToOutput = undefined
      rl.close()
      resolve(answer)
    })
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
      const username = positional[0]
      if (!username) usage()
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) {
        process.stderr.write('Invalid username (1-64 chars: letters, digits, . _ -).\n')
        process.exit(1)
      }
      if (getDashboardUser(username)) {
        process.stderr.write(`User "${username}" already exists.\n`)
        process.exit(1)
      }
      const pw = await acquirePassword(fromStdin)
      const hash = await hashPassword(pw)
      createDashboardUser(username, hash)
      process.stdout.write(`Created dashboard login "${username}".\n`)
      break
    }
    case 'reset-password': {
      const username = positional[0]
      if (!username) usage()
      const user = getDashboardUser(username)
      if (!user) {
        process.stderr.write(`User "${username}" not found.\n`)
        process.exit(1)
      }
      const pw = await acquirePassword(fromStdin)
      const hash = await hashPassword(pw)
      updateDashboardUserPassword(user.id, hash)
      revokeAllForUser(user.id)
      // Same audit + channel ping as the HTTP break-glass: a password reset
      // that skipped the current-password proof must always leave a trace.
      logConfigChange('security.break_glass_password_reset', null, user.username, 'cli')
      await notifySecurityEvent(`🔑 Jelszó-reset a dashboard CLI-ből (break-glass): "${user.username}". Ha nem te voltál, a gépen fut valami a nevedben.`)
      process.stdout.write(`Password reset for "${username}"; all their sessions were revoked.\n`)
      break
    }
    case 'list': {
      const users = listDashboardUsers()
      if (users.length === 0) {
        process.stdout.write('No dashboard users (token-only mode).\n')
        break
      }
      for (const u of users) {
        const created = new Date(u.created_at * 1000).toISOString()
        process.stdout.write(`${u.username}${u.disabled ? ' (disabled)' : ''}  created ${created}\n`)
      }
      break
    }
    case 'remove': {
      const username = positional[0]
      if (!username) usage()
      const user = getDashboardUser(username)
      if (!user) {
        process.stderr.write(`User "${username}" not found.\n`)
        process.exit(1)
      }
      revokeAllForUser(user.id)
      deleteDashboardUser(username)
      const remaining = listDashboardUsers().length
      process.stdout.write(`Removed "${username}".${remaining === 0 ? ' No users left -- back to token-only mode.' : ''}\n`)
      break
    }
    case 'security:reset': {
      const r = securityReset('cli')
      await notifySecurityEvent(`🚨 Biztonsági reset futott a dashboard CLI-ből: ${r.deviceKeysRevoked} eszközkulcs visszavonva, ${r.sessionsCleared} böngésző-munkamenet törölve. A hozzáférési token és a jelszavak változatlanok.`)
      process.stdout.write(
        `Security reset done: ${r.deviceKeysRevoked} device key(s) revoked, ${r.sessionsCleared} browser session(s) cleared.\n` +
        'Passwords and the dashboard token are untouched. Devices must be re-enrolled with new keys.\n',
      )
      break
    }
    case 'sessions:clear': {
      const username = positional[0]
      if (username) {
        const user = getDashboardUser(username)
        if (!user) {
          process.stderr.write(`User "${username}" not found.\n`)
          process.exit(1)
        }
        revokeAllForUser(user.id)
        process.stdout.write(`Cleared all sessions for "${username}".\n`)
      } else {
        getDb().exec('DELETE FROM auth_sessions')
        process.stdout.write('Cleared ALL dashboard login sessions.\n')
      }
      break
    }
    default:
      usage()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof PasswordPolicyError) {
      process.stderr.write(`${err.message}\n`)
    } else {
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    process.exit(1)
  })
