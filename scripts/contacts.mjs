#!/usr/bin/env node
// contacts.mjs -- Brainy's CLI for the contacts API (card f90928e3, node C4).
//
//   node scripts/contacts.mjs add     --domain business|family --name "<display name>" [--field F --value V] --source S [--source-date YYYY-MM-DD]
//   node scripts/contacts.mjs value   --domain D --id N --field F --value V --source S [--source-date YYYY-MM-DD]
//   node scripts/contacts.mjs find    --domain D [--q text] [--limit N]
//   node scripts/contacts.mjs show    --domain D --id N
//   node scripts/contacts.mjs retract --domain D --value-id N --source S [--source-date YYYY-MM-DD]
//   node scripts/contacts.mjs sync-ledger --domain D --id N [--ledger PATH] [--apply]   (manual: active emails -> recipient ledger; dry run unless --apply)
//
// Sends X-Agent-Id: brainy (self-declared, NOT authentication) and the
// dashboard Bearer token, read from store/.dashboard-token at call time. The
// token never appears in argv, stdout, stderr or error text. The JSON body is
// built with JSON.stringify and sent with fetch: no shell is involved.
// Base URL: MARVEEN_BASE_URL, else http://localhost:<MARVEEN_WEB_PORT|WEB_PORT|3420>.
// Exit 0 = 2xx (response JSON on stdout); 1 = non-2xx / network failure
// (status and the server's error field only); 2 = bad usage.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOMAINS = ['business', 'family']
const FIELDS = ['name', 'email', 'phone', 'address', 'org', 'relationship']

const usage = (msg) => { process.stderr.write(`usage error: ${msg}\n`); process.exit(2) }

const [cmd, ...rest] = process.argv.slice(2)
const opt = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (!a.startsWith('--')) usage(`unexpected argument ${a}`)
  if (a === '--apply') { opt.apply = true; continue }
  const v = rest[++i]
  if (v === undefined) usage(`${a} needs a value`)
  opt[a.slice(2)] = v
}

if (opt.apply && cmd !== 'sync-ledger') usage('--apply is only for sync-ledger')

const need = (k) => { if (!opt[k]) usage(`--${k} is required`); return opt[k] }
const domain = () => { const d = need('domain'); if (!DOMAINS.includes(d)) usage(`--domain must be one of: ${DOMAINS.join(', ')}`); return d }
const field = (k = 'field') => { const f = need(k); if (!FIELDS.includes(f)) usage(`--${k} must be one of: ${FIELDS.join(', ')}`); return f }
const intId = (k) => { const v = need(k); if (!/^\d+$/.test(v)) usage(`--${k} must be a number`); return v }
const today = () => new Date().toISOString().slice(0, 10)
const sourceDate = () => opt['source-date'] || today()

let method, path, body
switch (cmd) {
  case 'add': {
    const initial = []
    if (opt.field || opt.value) initial.push({ field: field(), value: need('value'), source: need('source'), source_date: sourceDate() })
    else need('source') // keep the source mandatory in the command even without a first value
    method = 'POST'; path = '/api/contacts'
    body = { domain: domain(), display_name: need('name'), values: initial }
    break
  }
  case 'value':
    method = 'POST'; path = `/api/contacts/${intId('id')}/values`
    body = { domain: domain(), field: field(), value: need('value'), source: need('source'), source_date: sourceDate() }
    break
  case 'find': {
    const p = new URLSearchParams({ domain: domain() })
    if (opt.q) p.set('q', opt.q)
    if (opt.limit) p.set('limit', opt.limit)
    method = 'GET'; path = `/api/contacts?${p}`
    break
  }
  case 'show':
    method = 'GET'; path = `/api/contacts/${intId('id')}?${new URLSearchParams({ domain: domain() })}`
    break
  case 'retract':
    method = 'POST'; path = `/api/contacts/values/${intId('value-id')}/retract`
    body = { domain: domain(), source: need('source'), source_date: sourceDate() }
    break
  case 'sync-ledger':
    // Reads the contact through the API, then writes the ledger locally.
    method = 'GET'; path = `/api/contacts/${intId('id')}?${new URLSearchParams({ domain: domain() })}`
    break
  default:
    usage('subcommand must be one of: add, value, find, show, retract, sync-ledger')
}

function base() {
  if (process.env.MARVEEN_BASE_URL) return process.env.MARVEEN_BASE_URL.replace(/\/+$/, '')
  return `http://localhost:${process.env.MARVEEN_WEB_PORT || process.env.WEB_PORT || 3420}`
}

let token
try {
  token = readFileSync(process.env.CONTACTS_TOKEN_FILE || join(root, 'store', '.dashboard-token'), 'utf8').trim()
} catch {
  process.stderr.write('error: dashboard token file not readable\n')
  process.exit(1)
}
if (!token) { process.stderr.write('error: dashboard token file is empty\n'); process.exit(1) }

const headers = { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'brainy' }
if (body !== undefined) headers['Content-Type'] = 'application/json'

let res, text
try {
  res = await fetch(base() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  text = await res.text()
} catch {
  process.stderr.write('error: dashboard not reachable\n')
  process.exit(1)
}

let parsed = null
try { parsed = JSON.parse(text) } catch { /* non-JSON body */ }
if (!res.ok) {
  const err = parsed && typeof parsed.error === 'string' ? parsed.error : 'no error field'
  process.stderr.write(`error: HTTP ${res.status}: ${err}\n`)
  process.exit(1)
}
if (cmd === 'sync-ledger') {
  // Manual-only ledger sync (AC25): never triggered by an API write.
  const { syncContactToLedger } = await import('./contacts-sync-ledger.mjs')
  const r = syncContactToLedger(parsed ?? {}, opt.ledger || undefined, { apply: opt.apply === true })
  process.stdout.write(JSON.stringify({ ledger: r }) + '\n')
  process.exit(r.failed ? 1 : 0)
}
process.stdout.write((parsed ? JSON.stringify(parsed, null, 2) : text) + '\n')
