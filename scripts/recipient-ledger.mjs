#!/usr/bin/env node
// The verified-recipient ledger: the evidence store behind the outbound-address
// gate in email-send-gate.mjs.
//
// Why this exists (2026-08-14): an agent wrote to support@connectors.hu, an
// address nobody had ever seen -- it was produced from the support@ convention,
// not from a source. The mail bounced 550 "User doesn't exist" and the owner
// found the failure, not the agent. The letter itself was correct; it simply
// reached nobody. The prose rule ("never invent facts") already existed and did
// not stop it, so the address check is mechanical from here on: a recipient the
// ledger does not know cannot be put in a To/Cc/Bcc field, not even in a draft.
//
// The ledger is deliberately dumb. It does not prove an address receives mail;
// it proves an agent NAMED A SOURCE before using the address, and it keeps that
// claim readable for the owner. That is the failure this gate is aimed at.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const LEDGER_VERSION = 1

// <root>/store/verified-recipients.json, keyed off this file's own location so
// the hook, the CLI and the tests all resolve the same path without config.ts.
export function ledgerPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'store', 'verified-recipients.json')
}

// Accepted evidence kinds. A free-text "I checked it" is NOT one of them: the
// source has to point at something the owner can re-open and re-read.
//   mail:<messageId>  the address appeared in a real message header we hold
//   site:<url>        printed on the party's own live page
//   owner             the owner gave it directly (in chat, on paper, by voice)
//   crm:<ref>         a Notion/CRM record we maintain
//   order:<id>        a WooCommerce order's billing address
//   doc:<ref>         a contract, invoice or other document in our files
const SOURCE_PATTERNS = [
  /^mail:\S+$/,
  /^site:https?:\/\/\S+$/,
  /^owner$/,
  /^crm:\S+$/,
  /^order:\S+$/,
  /^doc:\S+$/,
]

export function isValidSource(source) {
  const s = String(source ?? '').trim()
  return SOURCE_PATTERNS.some((re) => re.test(s))
}

export const SOURCE_HELP =
  'mail:<messageId> | site:<url> | owner | crm:<ref> | order:<id> | doc:<ref>'

// Addresses are compared case-insensitively and without the display name, so
// "Connectors <HELLO@Connectors.hu>" and "hello@connectors.hu" are one entry.
export function normalizeAddress(raw) {
  const s = String(raw ?? '').trim()
  const angled = s.match(/<([^>]+)>/)
  return (angled ? angled[1] : s).trim().toLowerCase()
}

// Split a recipient field into addresses. Handles the comma-separated string
// form (google-workspace manage_email) and the array form (Gmail MCP tools).
export function splitAddresses(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',')
  return items.map(normalizeAddress).filter((a) => a.includes('@'))
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, recipients: {} }
}

// Read the ledger. Returns null when it cannot be read or parsed -- the caller
// decides what that means; the gate treats it as "nothing is verified" and
// blocks, because a broken evidence store must not silently open the gate.
export function loadLedger(path = ledgerPath(), readFile = (p) => readFileSync(p, 'utf-8')) {
  try {
    const parsed = JSON.parse(readFile(path))
    if (!parsed || typeof parsed !== 'object') return null
    const recipients = parsed.recipients
    if (!recipients || typeof recipients !== 'object') return null
    return { version: parsed.version ?? LEDGER_VERSION, recipients }
  } catch {
    return null
  }
}

// Pure lookup over an already-loaded ledger.
export function isVerifiedIn(ledger, address) {
  if (!ledger) return false
  return Object.prototype.hasOwnProperty.call(ledger.recipients, normalizeAddress(address))
}

export function addRecipient(address, source, note, path = ledgerPath()) {
  const addr = normalizeAddress(address)
  if (!addr.includes('@')) throw new Error(`not an email address: ${address}`)
  if (!isValidSource(source)) {
    throw new Error(`invalid --source "${source}". Accepted: ${SOURCE_HELP}`)
  }
  const ledger = loadLedger(path) ?? emptyLedger()
  ledger.recipients[addr] = {
    source: String(source).trim(),
    note: String(note ?? '').trim(),
    added_at: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
  return ledger.recipients[addr]
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] ?? ''
      i += 1
    } else positional.push(a)
  }
  return { positional, flags }
}

function usage() {
  return [
    'Verified-recipient ledger (outbound address gate).',
    '',
    '  node scripts/recipient-ledger.mjs add <address> --source <source> [--note "<why>"]',
    '  node scripts/recipient-ledger.mjs check <address>',
    '  node scripts/recipient-ledger.mjs list',
    '',
    `  --source must be one of: ${SOURCE_HELP}`,
    '  The source has to point at something re-openable. If you cannot name one,',
    '  the address is not verified -- go find it, or ask the owner.',
  ].join('\n')
}

function isInvokedDirectly() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '')
  } catch {
    return false
  }
}

if (isInvokedDirectly()) {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [cmd, arg] = positional
  try {
    if (cmd === 'add') {
      const entry = addRecipient(arg, flags.source, flags.note)
      process.stdout.write(`added ${normalizeAddress(arg)} (source: ${entry.source})\n`)
    } else if (cmd === 'check') {
      const ok = isVerifiedIn(loadLedger(), arg)
      process.stdout.write(`${normalizeAddress(arg)}: ${ok ? 'VERIFIED' : 'NOT VERIFIED'}\n`)
      process.exit(ok ? 0 : 1)
    } else if (cmd === 'list') {
      const ledger = loadLedger() ?? emptyLedger()
      const rows = Object.entries(ledger.recipients)
      if (!rows.length) process.stdout.write('(empty)\n')
      for (const [addr, meta] of rows) {
        process.stdout.write(`${addr}\t${meta.source}\t${meta.note ?? ''}\n`)
      }
    } else {
      process.stdout.write(`${usage()}\n`)
      process.exit(cmd ? 1 : 0)
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
