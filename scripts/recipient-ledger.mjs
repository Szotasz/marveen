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

import { readFileSync, writeFileSync, mkdirSync, realpathSync, chmodSync, renameSync, rmSync } from 'node:fs'
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

// Parse a recipient field into the addresses a mail tool will deliver to,
// plus every piece the parser cannot vouch for.
//
// The splitter that stood here comma-split only a STRING field, never an array
// item, and normalizeAddress takes only the first <...>: to: ["A
// <known@example.com>, B <invented@example.org>"] was checked as
// known@example.com alone, while Gmail joins the array into one To header and
// delivers to both; "Known <known@example.com> <invented@example.org>" likewise. Now EVERY item (string field or array element) is
// split on , and ; (the separators a To/Cc/Bcc header and the manage_email
// string form use), and each piece must parse as exactly one address:
//   - no '@' at all: carries no deliverable address (a display-name fragment
//     such as the '"Doe' of '"Doe, John" <j@example.com>', or an empty piece), skipped;
//   - more than one '@': ambiguous (two addresses, an address in the display
//     name, a header continuation) -> unparseable, with ONE exception: a
//     display name that IS the bracketed address ("jane@x.com" <jane@x.com>,
//     quoted or not, compared case-insensitively), the form many mail
//     clients write when there is no real name;
//   - '<' or '>' anywhere: only "display <addr>" with ONE bracket pair at the
//     end parses, and the '@' must sit inside the brackets;
//   - the address itself must be free of whitespace, quotes, brackets and
//     separators.
// A non-scalar array item (nested array / object) or an object field value is
// unparseable: its string form differs between tools. A gate DENIES on any
// unparseable piece (email-send-gate.mjs unparseableRecipients). Whitespace is
// spelled out as ASCII, so this cannot drift from a Python twin on exotic
// Unicode spaces.
const ADDR_SEPARATOR = /[,;]/
const ADDR_TRIM = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g
const ANGLE_FORM = /^([^<>]*)<([^<>]*)>$/
const BARE_ADDRESS = /^[^ \t\r\n\f\v"<>()[\]\\,;:@]+@[^ \t\r\n\f\v"<>()[\]\\,;:@]+$/

function parseAddressPiece(piece) {
  const ats = (piece.match(/@/g) ?? []).length
  let addr = piece
  if (/[<>]/.test(piece)) {
    const m = piece.match(ANGLE_FORM)
    if (!m) return null
    addr = m[2].replace(ADDR_TRIM, '')
    if (ats > 1) {
      // the display name must BE the address: anything else hides a second one
      const display = m[1].replace(ADDR_TRIM, '').replace(/^"(.*)"$/, '$1').replace(ADDR_TRIM, '')
      if (display.toLowerCase() !== addr.toLowerCase()) return null
    }
  } else if (ats > 1) {
    return null
  }
  return BARE_ADDRESS.test(addr) ? addr.toLowerCase() : null
}

export function parseAddresses(value) {
  const addresses = []
  const unparseable = []
  if (value === undefined || value === null) return { addresses, unparseable }
  const items = Array.isArray(value) ? value : [value]
  for (const item of items) {
    if (item === undefined || item === null) continue
    if (typeof item === 'object') {
      unparseable.push(JSON.stringify(item))
      continue
    }
    for (const raw of String(item).split(ADDR_SEPARATOR)) {
      const piece = raw.replace(ADDR_TRIM, '')
      if (!piece.includes('@')) continue
      const addr = parseAddressPiece(piece)
      if (addr === null) unparseable.push(piece)
      else addresses.push(addr)
    }
  }
  return { addresses, unparseable }
}

// Split a recipient field into addresses: the comma-separated string form
// (google-workspace manage_email) and the array form (Gmail MCP tools). It
// DROPS what it cannot parse, so it is not a gate primitive on its own: a gate
// reads parseAddresses(...).unparseable and denies on it.
export function splitAddresses(value) {
  return parseAddresses(value).addresses
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, recipients: {} }
}

// Read the ledger, with the verdict spelled out: { ledger } when usable, else
// { ledger: null, missing, reason }. `missing` is true ONLY when the file does
// not exist (ENOENT); every other failure (unreadable, not JSON, wrong shape)
// is a present-but-unusable ledger, which a writer must never replace (see
// addRecipient).
//
// The bytes are decoded with a FATAL UTF-8 decoder that keeps a BOM: the
// Python twin (scripts/hooks/recipient_ledger.py) refuses both, and the two
// readers must give the SAME verdict on the SAME file
// (scripts/hooks/recipient-ledger-file-cases.json). readFileSync(p, 'utf-8')
// would silently turn invalid bytes into U+FFFD and read the file anyway.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function inspectLedger(path = ledgerPath(), readFile = (p) => readFileSync(p)) {
  let raw
  try {
    raw = readFile(path)
  } catch (err) {
    if (err?.code === 'ENOENT') return { ledger: null, missing: true, reason: `the ledger does not exist (${path})` }
    return { ledger: null, missing: false, reason: `the ledger cannot be read (${path}: ${err?.message ?? err})` }
  }
  let text
  try {
    text = typeof raw === 'string' ? raw : STRICT_UTF8.decode(raw)
  } catch {
    return { ledger: null, missing: false, reason: `the ledger is not valid UTF-8 (${path})` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ledger: null, missing: false, reason: `the ledger is not valid JSON (${path}: ${err?.message ?? err})` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ledger: null, missing: false, reason: `the ledger is not a JSON object (${path})` }
  }
  const recipients = parsed.recipients
  // An array is an object to typeof, but an address written into it as a key
  // vanishes on the next JSON.stringify: a recipients ARRAY is unusable too.
  if (!recipients || typeof recipients !== 'object' || Array.isArray(recipients)) {
    return { ledger: null, missing: false, reason: `the ledger has no recipients map (${path})` }
  }
  return { ledger: { version: parsed.version ?? LEDGER_VERSION, recipients }, missing: false, reason: null }
}

// Read the ledger. Returns null when it cannot be read or parsed -- the caller
// decides what that means; the gate treats it as "nothing is verified" and
// blocks, because a broken evidence store must not silently open the gate.
export function loadLedger(path = ledgerPath(), readFile = (p) => readFileSync(p)) {
  return inspectLedger(path, readFile).ledger
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
  // A fresh ledger ONLY when the file is absent. A present but unusable file
  // (a truncated write, a conflicted merge, a hand edit gone wrong) used to be
  // replaced by an empty ledger plus this one entry, silently deleting every
  // verified recipient. Now the write is refused and the file is left
  // byte-identical: fix or restore it first.
  const seen = inspectLedger(path)
  if (!seen.ledger && !seen.missing) {
    throw new Error(`refusing to overwrite the existing ledger, it is not usable: ${seen.reason}. ` +
      'Repair it by hand or restore it from a backup, then add again (overwriting it would drop every verified recipient).')
  }
  const ledger = seen.ledger ?? emptyLedger()
  ledger.recipients[addr] = {
    source: String(source).trim(),
    note: String(note ?? '').trim(),
    added_at: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  // LEDGERMODE920: the ledger is a list of real customer addresses and it
  // lands in a 0755 store/, so the default 0644 made it world-readable to
  // every local account. 0600 keeps it to the owner the gate runs as.
  // Written to a temp file in the same directory and renamed over the ledger:
  // a write cut short (a full disk, a killed process) leaves the old ledger
  // in place instead of a truncated one, which every gate would then refuse.
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    // mode: on writeFileSync only applies when the file is CREATED; the temp
    // file always is, and chmod covers a umask that narrowed it further or a
    // filesystem that ignores it. Best effort: the write itself is not.
    try { chmodSync(tmp, 0o600) } catch { /* mode is best effort, the write is not */ }
    renameSync(tmp, path)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    throw err
  }
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
    if (cmd === 'check' || cmd === 'list') {
      // An unusable ledger is named, not shown as "(empty)" / "NOT VERIFIED".
      const seen = inspectLedger()
      if (!seen.ledger && !seen.missing) throw new Error(`the ledger is not usable: ${seen.reason}`)
    }
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
