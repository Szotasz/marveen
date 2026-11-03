// D1 (1): how the vault resolver scripts reach the dashboard's POST /api/vault/resolve. A read through
// the dashboard leaves a row in its vault log (who claimed which secret) and can be held to the
// allowlist (VAULT_ACL_MODE=enforce). This is a trail and an access rule, not isolation: every agent runs
// as the same OS user and can read the master-key file. The token is read here and never printed.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The .env grammar of src/env-parse.ts parseEnvContent, ported line for line (a test holds the two
// together): the server reads .env this way, so the scripts must too.
export function envFileSetting(root, key) {
  let content = ''
  try { content = readFileSync(join(root, '.env'), 'utf-8') } catch { return '' }
  let result = ''
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const k = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (k === key) result = value
  }
  return result
}

// store/config-overrides.json, which the Settings page writes and the server reads first (src/settings-store.ts;
// a file that cannot be read counts as empty there too).
export function overrideSetting(root, key) {
  try {
    const data = JSON.parse(readFileSync(join(root, 'store', 'config-overrides.json'), 'utf-8'))
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, key)) {
      return String(data[key])
    }
  } catch { /* missing or unreadable */ }
  return undefined
}

// Env first, then a KEY=value line of <root>/.env, then the default.
export function installSetting(root, key, def) {
  const v = process.env[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return envFileSetting(root, key) || def
}

// The agent name this process claims (sent as X-Agent-Id; self-asserted, never authentication):
// MARVEEN_AGENT_ID or MARVEEN_AGENT_NAME when the launcher exported one, else the <name> of the last
// /agents/<name>/ component of the working directory (an agent's MCP servers start in its folder).
export function claimedAgentName(cwd = process.cwd()) {
  const fromEnv = (process.env.MARVEEN_AGENT_ID || process.env.MARVEEN_AGENT_NAME || '').trim()
  if (fromEnv) return fromEnv
  const parts = cwd.split('/')
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'agents') return /^[a-z0-9][a-z0-9-]{0,63}$/.test(parts[i + 1] || '') ? parts[i + 1] : ''
  }
  return ''
}

// The server's rule (src/web/vault-acl.ts vaultAclMode): the environment saying 'enforce', or the setting in the
// registry's order -- the Settings page value, else the .env line, else 'audit'.
export function vaultAclMode(root) {
  if ((process.env.VAULT_ACL_MODE || '').trim() === 'enforce') return 'enforce'
  const override = overrideSetting(root, 'VAULT_ACL_MODE')
  const setting = override !== undefined ? override : envFileSetting(root, 'VAULT_ACL_MODE')
  return setting.trim() === 'enforce' ? 'enforce' : 'audit'
}

function dashboardTokenFile(root) {
  return process.env.VAULT_RESOLVE_TOKEN_FILE || join(root, 'store', '.dashboard-token')
}

// Whether a dashboard token file exists (its contents are checked only when a request is made).
export function dashboardConfigured(root) {
  return existsSync(dashboardTokenFile(root))
}

// How long the resolver scripts wait for the dashboard. A scheduled task's preCheck runs under
// PRECHECK_TIMEOUT_MS (10 s, src/web/schedule-runner.ts) and is killed at it, so a wait of the same length
// never reaches the fallback after it (audit: resolve locally, enforce: exit 5) and the runner starts the model
// anyway. Half the limit leaves the other half to the node start and the local fallback. An install whose
// dashboard is slower raises it with VAULT_RESOLVE_TIMEOUT_MS (whole milliseconds, > 0; anything else is ignored).
export const VAULT_RESOLVE_DEFAULT_TIMEOUT_MS = 5_000

export function resolveTimeoutMs(env = process.env) {
  const raw = (env.VAULT_RESOLVE_TIMEOUT_MS || '').trim()
  const n = /^\d+$/.test(raw) ? Number(raw) : 0
  return n > 0 && Number.isSafeInteger(n) ? n : VAULT_RESOLVE_DEFAULT_TIMEOUT_MS
}

// VAULTURLGATE1027: the dashboard the resolver may ask is on this machine. VAULT_RESOLVE_URL (tests, a
// moved port) is read from the environment, and the request sends the dashboard token, so any other host
// would carry the token off the machine. Only http(s) to 127.0.0.1, ::1 or localhost, with no user info.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

export function isLoopbackUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return false }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && LOOPBACK_HOSTS.has(u.hostname)
}

// { ok: true, values, missing, refused } or { ok: false, configured, error }.
// configured === false means there is no dashboard token at all (not an install).
export async function resolveViaDashboard(root, ids, { timeoutMs = resolveTimeoutMs() } = {}) {
  const tokenFile = dashboardTokenFile(root)
  if (!existsSync(tokenFile)) return { ok: false, configured: false, error: 'no dashboard token' }
  let token = ''
  try { token = readFileSync(tokenFile, 'utf-8').trim() } catch { return { ok: false, configured: true, error: 'unreadable dashboard token' } }
  if (!token) return { ok: false, configured: true, error: 'empty dashboard token' }
  if (!/^[\x21-\x7e]+$/.test(token)) return { ok: false, configured: true, error: 'malformed dashboard token' }
  const url = process.env.VAULT_RESOLVE_URL || `http://127.0.0.1:${installSetting(root, 'WEB_PORT', '3420')}/api/vault/resolve`
  // The request carries the dashboard token: a VAULT_RESOLVE_URL off this machine is refused before it is built.
  if (!isLoopbackUrl(url)) return { ok: false, configured: true, error: 'VAULT_RESOLVE_URL is not a loopback address' }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const agent = claimedAgentName()
  if (agent) headers['X-Agent-Id'] = agent
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ids }), signal: ctrl.signal })
    if (!res.ok) return { ok: false, configured: true, error: `HTTP ${res.status}` }
    const body = await res.json()
    if (!body || typeof body !== 'object' || !body.values || typeof body.values !== 'object') {
      return { ok: false, configured: true, error: 'unexpected answer' }
    }
    return {
      ok: true,
      values: body.values,
      missing: Array.isArray(body.missing) ? body.missing : [],
      refused: Array.isArray(body.refused) ? body.refused : [],
    }
  } catch (err) {
    const text = err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err)
    return { ok: false, configured: true, error: text.split(token).join('***') }
  } finally {
    clearTimeout(timer)
  }
}

// The dashboard accepts at most 100 ids per request: send the ids in batches and merge the answers.
// Any failed batch fails the whole call (the first failure is returned). The wait (timeoutMs) is one budget for
// the whole call, not one per batch: three slow batches must not add up to three times the limit.
export async function resolveInBatches(root, ids, opts, size = 100) {
  const values = Object.create(null)
  const missing = []
  const refused = []
  const deadline = Date.now() + ((opts && opts.timeoutMs) || resolveTimeoutMs())
  for (let i = 0; i < ids.length; i += size) {
    const r = await resolveViaDashboard(root, ids.slice(i, i + size), { ...opts, timeoutMs: deadline - Date.now() })
    if (!r.ok) return r
    for (const k of Object.keys(r.values)) values[k] = r.values[k]
    missing.push(...r.missing)
    refused.push(...r.refused)
  }
  return { ok: true, values, missing, refused }
}
