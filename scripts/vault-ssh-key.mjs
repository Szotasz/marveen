#!/usr/bin/env node
// Materialize the private key of a server registered in the SSH vault, for
// scripts/vault-ssh.sh. Not meant to be called by hand.
//
//   node scripts/vault-ssh-key.mjs <server-id-or-name> <key-file>
//
// The server is looked up in vault_ssh_servers (read-only) by id, then by
// name (case-insensitive). Its ssh_key_id names the vault secret
// `ssh-key-<id>`, which is written to <key-file> with mode 0600 and an
// exclusive create, so an existing file is never overwritten.
//
// stdout carries ONE line, nothing secret: `<user>@<host> <port>`.
// The key itself is never printed, and no error message contains it.
//
//   exit 0  key written, target on stdout
//   exit 2  usage error
//   exit 3  no such server (or the name is ambiguous)
//   exit 4  the server has no key assigned
//   exit 5  the key is assigned but its secret is missing from the vault
//   exit 6  the key file could not be written
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const [selector, keyFile] = process.argv.slice(2)
if (!selector || !keyFile) {
  process.stderr.write('usage: vault-ssh-key.mjs <server-id-or-name> <key-file>\n')
  process.exit(2)
}

const require = createRequire(join(projectRoot, 'package.json'))
const Database = require('better-sqlite3')
const db = new Database(join(projectRoot, 'store', 'claudeclaw.db'), { readonly: true, fileMustExist: true })
let server
try {
  server = db.prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get(selector)
  if (!server) {
    const byName = db.prepare('SELECT * FROM vault_ssh_servers WHERE lower(name) = lower(?)').all(selector)
    if (byName.length > 1) {
      process.stderr.write(`vault-ssh-key: the name "${selector}" matches ${byName.length} servers; use the id\n`)
      process.exit(3)
    }
    server = byName[0]
  }
} finally {
  db.close()
}
if (!server) {
  process.stderr.write(`vault-ssh-key: no server "${selector}" in the SSH vault\n`)
  process.exit(3)
}
if (!server.ssh_key_id) {
  process.stderr.write(`vault-ssh-key: server "${server.id}" has no key assigned\n`)
  process.exit(4)
}

const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))
const key = getSecret(`ssh-key-${server.ssh_key_id}`)
if (!key) {
  process.stderr.write(`vault-ssh-key: the vault has no secret for key ${server.ssh_key_id} (server "${server.id}")\n`)
  process.exit(5)
}

try {
  // ssh refuses a private key without the trailing newline.
  writeFileSync(keyFile, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600, flag: 'wx' })
} catch (err) {
  process.stderr.write(`vault-ssh-key: cannot write the key file: ${err.code ?? 'error'}\n`)
  process.exit(6)
}

process.stdout.write(`${server.username}@${server.host} ${server.port ?? 22}\n`)
