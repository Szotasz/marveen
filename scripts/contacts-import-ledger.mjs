#!/usr/bin/env node
// contacts-import-ledger.mjs -- manual, one-way import ledger -> contacts
// (card f90928e3, node C3, AC25). Never automatic.
//
//   node scripts/contacts-import-ledger.mjs --domain business|family --address a@x.hu [--address b@y.hu ...] [--apply] [--ledger PATH]
//
// --domain and at least one --address are required: only the named addresses
// are imported, never the whole ledger. Default is a dry run that prints what
// would be created; --apply sends it through the contacts API (X-Agent-Id:
// brainy, Bearer token read at call time, never printed). The ledger source
// string maps 1:1 (same grammar). The ledger file is only read.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLedger, normalizeAddress, ledgerPath } from './recipient-ledger.mjs'

const DOMAINS = ['business', 'family']

/** Pure plan: what would be created. Throws on bad input. */
export function planImport({ domain, addresses, ledgerFile }) {
  if (!DOMAINS.includes(domain)) throw new Error(`--domain is required and must be one of: ${DOMAINS.join(', ')}`)
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error('at least one --address is required (only named addresses are imported)')
  const ledger = loadLedger(ledgerFile)
  if (!ledger) throw new Error('ledger is missing or not usable')
  const plan = []
  const missing = []
  for (const raw of addresses) {
    const addr = normalizeAddress(raw)
    const entry = Object.prototype.hasOwnProperty.call(ledger.recipients, addr) ? ledger.recipients[addr] : null
    if (!entry) { missing.push(addr); continue }
    plan.push({
      domain,
      display_name: addr,
      values: [{ field: 'email', value: addr, source: entry.source, source_date: String(entry.added_at ?? '').slice(0, 10) }],
    })
  }
  return { plan, missing }
}

/** Dry run writes nothing; apply calls post(body) once per planned contact. */
export async function runImport({ domain, addresses, ledgerFile, apply = false, post }) {
  const { plan, missing } = planImport({ domain, addresses, ledgerFile })
  const created = []
  if (apply) {
    for (const body of plan) created.push(await post(body))
  }
  return { dryRun: !apply, planned: plan.length, missing: missing.length, created: created.length }
}

function parse(argv) {
  const o = { addresses: [], apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') o.apply = true
    else if (a === '--dry-run') o.apply = false
    else if (a === '--domain') o.domain = argv[++i]
    else if (a === '--address') o.addresses.push(argv[++i] ?? '')
    else if (a === '--ledger') o.ledger = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return o
}

async function main() {
  let o
  try { o = parse(process.argv.slice(2)) } catch (e) { process.stderr.write(`usage error: ${e.message}\n`); process.exit(2) }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const post = async (body) => {
    const token = readFileSync(join(root, 'store', '.dashboard-token'), 'utf8').trim()
    const port = process.env.MARVEEN_WEB_PORT || process.env.WEB_PORT || '3420'
    const base = process.env.MARVEEN_BASE_URL || `http://localhost:${port}`
    const res = await fetch(`${base}/api/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Agent-Id': 'brainy' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`create failed: HTTP ${res.status}`)
    return res.json()
  }
  try {
    const plan = planImport({ domain: o.domain, addresses: o.addresses, ledgerFile: o.ledger ?? ledgerPath() })
    if (!o.apply) {
      for (const p of plan.plan) process.stdout.write(`would create: ${p.display_name} (${p.domain}, source ${p.values[0].source})\n`)
      for (const m of plan.missing) process.stdout.write(`not in ledger: ${m}\n`)
      process.stdout.write(`dry run: ${plan.plan.length} planned, nothing written (use --apply)\n`)
      return
    }
    const r = await runImport({ domain: o.domain, addresses: o.addresses, ledgerFile: o.ledger ?? ledgerPath(), apply: true, post })
    process.stdout.write(`${JSON.stringify(r)}\n`)
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`)
    process.exit(e.message.startsWith('--') || e.message.startsWith('at least') ? 2 : 1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
