#!/usr/bin/env node
// VAULTSZELES826 PR-A: propose store/vault-acl.json from the observation week (VAULT_ACL_AGENT_MODE=audit).
//
//   node scripts/vault-acl-suggest.mjs [--since YYYY-MM-DD] [--log <dashboard.log>] [--acl <vault-acl.json>]
//
// Reads the dashboard log (and its rotated .gz generations) and prints ONE JSON report to stdout:
//   proposed_acl   the current file plus every (secret id, agent) pair a sub-agent's OWN token read during the window
//   new_entries    the pairs the current file does not list yet, with their read counts
//   not_found      ids an agent asked for that did not exist (a typo or a removed secret: not proposed)
//   scope_403      every agent-token-scope refusal in the window (agent, method, path, count): routes the allowlist
//                  may still be missing
//   claimed_unverified  reads by a shared-token caller that only CLAIMED an agent name (X-Agent-Id). Not proposed:
//                  the claim is self-asserted. Listed so the owner sees who still reads on the shared token.
//
// It never writes store/vault-acl.json: the list is the owner's to approve. Only an authenticated row (kind 'agent',
// the sub-agent's own token) is a proposal; SSH material and the vault's sub-resources never are (the same floor the
// server holds). No secret VALUE is in the log (vault-acl.ts logVaultRead has no parameter for it), so none is here.
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VAULT_MSG = 'vault: secret value read'
const SCOPE_MSG = 'agent token: request outside the sub-agent scope refused (403)'
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g
const HEAD_RE = /^\[(\d{4}-\d{2}-\d{2}) [^\]]*\]\s+\S+\s+\([^)]*\):\s*(.*)$/
const FIELD_RE = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s(.*)$/

/** The same floor as vault-acl.ts isAgentReadableDecodedVaultId (a .mjs cannot import the TypeScript). */
export function agentReadableId(id) {
  const lc = String(id).trim().toLowerCase()
  if (!lc || lc.includes('/')) return false
  if (['bindings', 'scan', 'sync', 'import', 'resolve'].includes(lc)) return false
  if (lc.startsWith('ssh')) return false
  return true
}

function parseValue(raw) {
  try { return JSON.parse(raw) } catch { return raw }
}

/** Records of the two kinds we read, from pino-pretty text (ANSI colours allowed) or JSON lines. */
export function parseRecords(text) {
  const out = []
  let cur = null
  const flush = () => { if (cur && (cur.msg === VAULT_MSG || cur.msg === SCOPE_MSG)) out.push(cur); cur = null }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(ANSI_RE, '')
    if (line.startsWith('{')) {
      flush()
      try {
        const o = JSON.parse(line)
        if (o && (o.msg === VAULT_MSG || o.msg === SCOPE_MSG)) {
          const date = typeof o.time === 'number' ? new Date(o.time).toISOString().slice(0, 10) : ''
          out.push({ ...o, date })
        }
      } catch { /* not a JSON log line */ }
      continue
    }
    const head = HEAD_RE.exec(line)
    if (head) { flush(); cur = { date: head[1], msg: head[2].trim() }; continue }
    const f = cur && FIELD_RE.exec(line)
    if (f) cur[f[1]] = parseValue(f[2].trim())
  }
  flush()
  return out
}

export function suggest(records, existingAcl = {}, since = '') {
  const inWindow = records.filter(r => !since || (r.date && r.date >= since))
  const proposed = Object.create(null)
  for (const [id, agents] of Object.entries(existingAcl)) if (Array.isArray(agents)) proposed[id] = [...agents]
  const pairs = new Map()
  const notFound = new Map()
  const scope = new Map()
  const claimed = new Map()
  let floorRefused = 0
  for (const r of inWindow) {
    if (r.msg === SCOPE_MSG) {
      const k = `${r.agent}\u0000${r.method}\u0000${r.path}`
      scope.set(k, (scope.get(k) ?? 0) + 1)
      continue
    }
    if (r.kind === 'agent') {
      const id = String(r.id ?? '')
      const agent = String(r.principal ?? '')
      if (!id || !agent) continue
      if (!agentReadableId(id)) { floorRefused++; continue }
      if (r.found === false) { const k = `${agent}\u0000${id}`; notFound.set(k, (notFound.get(k) ?? 0) + 1); continue }
      const k = `${id}\u0000${agent}`
      pairs.set(k, (pairs.get(k) ?? 0) + 1)
    } else if (r.kind === 'token' && typeof r.claimed === 'string' && r.claimed) {
      const k = `${r.claimed}\u0000${r.id}`
      claimed.set(k, (claimed.get(k) ?? 0) + 1)
    }
  }
  const newEntries = []
  for (const [k, reads] of [...pairs].sort()) {
    const [id, agent] = k.split('\u0000')
    const listed = Object.prototype.hasOwnProperty.call(proposed, id) ? proposed[id] : undefined
    if (listed && listed.includes(agent)) continue
    newEntries.push({ id, agent, reads })
    proposed[id] = [...(listed ?? []), agent].sort()
  }
  const split = (m, names) => [...m].sort().map(([k, count]) => ({ ...Object.fromEntries(k.split('\u0000').map((v, i) => [names[i], v])), count }))
  const dates = inWindow.map(r => r.date).filter(Boolean).sort()
  return {
    window: { from: dates[0] ?? null, to: dates.at(-1) ?? null, since: since || null },
    proposed_acl: Object.fromEntries(Object.keys(proposed).sort().map(id => [id, proposed[id]])),
    new_entries: newEntries,
    not_found: split(notFound, ['agent', 'id']),
    floor_refused: floorRefused,
    scope_403: split(scope, ['agent', 'method', 'path']),
    claimed_unverified: split(claimed, ['claimed', 'id']),
  }
}

function readLogs(logPath) {
  const dir = dirname(logPath)
  const base = basename(logPath)
  const texts = []
  // Oldest first: dashboard.log.<n>.gz, a higher n is older (numeric, so .10 sorts before .9).
  const gen = (f) => Number(f.slice(base.length + 1, -3))
  const gens = existsSync(dir)
    ? readdirSync(dir).filter(f => f.startsWith(`${base}.`) && f.endsWith('.gz') && Number.isInteger(gen(f))).sort((a, b) => gen(b) - gen(a))
    : []
  for (const g of gens) texts.push(gunzipSync(readFileSync(join(dir, g))).toString('utf8'))
  if (existsSync(logPath)) texts.push(readFileSync(logPath, 'utf8'))
  return { text: texts.join('\n'), files: [...gens, existsSync(logPath) ? base : null].filter(Boolean) }
}

function main(argv) {
  const storeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'store')
  const opt = { log: join(storeDir, 'dashboard.log'), acl: join(storeDir, 'vault-acl.json'), since: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--log' || a === '--acl' || a === '--since') { opt[a.slice(2)] = argv[++i] ?? ''; continue }
    if (a === '-h' || a === '--help') { process.stdout.write('usage: vault-acl-suggest.mjs [--since YYYY-MM-DD] [--log <file>] [--acl <file>]\n'); return 0 }
    process.stderr.write(`unknown argument: ${a}\n`)
    return 2
  }
  if (opt.since && !/^\d{4}-\d{2}-\d{2}$/.test(opt.since)) { process.stderr.write('--since must be YYYY-MM-DD\n'); return 2 }
  let acl = {}
  if (existsSync(opt.acl)) {
    try { acl = JSON.parse(readFileSync(opt.acl, 'utf8')) } catch { process.stderr.write(`${opt.acl} is not valid JSON: fix it first\n`); return 1 }
  }
  const { text, files } = readLogs(opt.log)
  if (files.length === 0) { process.stderr.write(`no log at ${opt.log}\n`); return 1 }
  process.stdout.write(JSON.stringify({ files, ...suggest(parseRecords(text), acl, opt.since) }, null, 2) + '\n')
  return 0
}

const entry = process.argv[1] ? (() => { try { return realpathSync(process.argv[1]) } catch { return '' } })() : ''
if (entry && entry === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
