#!/usr/bin/env node
// Resolve vault-backed MCP request headers at connection time.
//
// Claude Code runs a remote MCP server's `headersHelper` fresh on every
// connection (and again on 401/403) and uses the JSON object printed to stdout
// as the request headers. This is the remote-server analogue of
// vault-env-wrapper.sh: the secret is resolved from the Vault at connection
// time and NEVER written to .mcp.json -- only the vault secret id is on disk.
//
// Args: one per header, in the form  HeaderName=Scheme:::vaultSecretId
//   - Scheme is optional (may be empty); when present the header value becomes
//     "Scheme <secret>" (e.g. "Bearer <token>"), otherwise the raw secret.
//   - The ":::" separator keeps every argument free of spaces so the string is
//     safe when Claude Code passes headersHelper through a shell.
// Output: a JSON object {HeaderName: "value", ...} on stdout.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInBatches, vaultAclMode, dashboardConfigured } from './vault-dashboard-client.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

// stdout IS the contract here (the JSON object): nothing else may reach it. The vault module's logger writes to
// stdout, and on macOS without a GUI session (a LaunchDaemon) its Keychain migration fails on every call and logs a
// warning -- which used to corrupt the headers JSON. This process only READS secrets, so it silences the logger and
// leaves the migration to the dashboard process. Both must be set BEFORE the module is imported.
// NOTE: this OVERRIDES an operator-set LOG_LEVEL for this short-lived process on purpose (stdout is the contract). Failures stay
// visible on STDERR (the lines this script writes itself) and in the exit code; to debug the vault module, run it from a REPL or the
// dashboard process, not through this script.
process.env.LOG_LEVEL = 'silent'
process.env.MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION = '1'

const wanted = []
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=')
  if (eq < 0) continue
  const headerName = arg.slice(0, eq)
  const rest = arg.slice(eq + 1)
  const sep = rest.indexOf(':::')
  const scheme = sep >= 0 ? rest.slice(0, sep) : ''
  const vaultId = (sep >= 0 ? rest.slice(sep + 3) : rest).trim()
  if (!headerName || !vaultId) continue
  // VAULTSZELES826: an SSH private key never leaves as an HTTP header to a remote server
  // (same rule as isSshPrivateKeyId in vault-acl.ts).
  if (vaultId.startsWith('ssh-key-')) {
    process.stderr.write(`vault-headers-helper: refused, SSH private keys are not sent as headers: "${vaultId}"\n`)
    continue
  }
  wanted.push({ headerName, scheme, vaultId, unsendable: vaultId.length > 200 })
}

// The dashboard first (its vault log, its allowlist); the local vault module only when that cannot be used.
const ids = [...new Set(wanted.filter(w => !w.unsendable).map(w => w.vaultId))]
let fromDashboard = null
if (ids.length > 0) {
  const r = await resolveInBatches(projectRoot, ids)
  if (r.ok) fromDashboard = r
  else if (vaultAclMode(projectRoot) === 'enforce') {
    process.stderr.write(`vault-headers-helper: the dashboard could not be reached (${r.error}); VAULT_ACL_MODE=enforce, no header is resolved locally\n`)
    process.exit(5)
  } else if (r.configured) {
    process.stderr.write(`vault-headers-helper: WARNING: the dashboard could not be reached (${r.error}); resolving locally, and this read is not in the dashboard's vault log\n`)
  }
} else if (wanted.length > 0 && (vaultAclMode(projectRoot) === 'enforce' || dashboardConfigured(projectRoot))) {
  // Only ids that cannot be sent: there is nothing to ask the dashboard. They count as missing, as in its answer; the
  // local vault is asked only in audit mode without a dashboard token file (the path before the dashboard existed).
  fromDashboard = { values: Object.create(null), missing: [], refused: [] }
}

let getSecret = null
if (!fromDashboard && wanted.length > 0) {
  // Same pattern as vault-resolve.mjs: import the compiled vault module.
  ;({ getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js')))
}

const headers = {}
for (const { headerName, scheme, vaultId, unsendable } of wanted) {
  let secret = null
  if (fromDashboard) {
    const v = !unsendable && Object.prototype.hasOwnProperty.call(fromDashboard.values, vaultId) ? fromDashboard.values[vaultId] : null
    if (typeof v === 'string') secret = v
    else if (fromDashboard.refused.some(x => x && x.id === vaultId && x.reason === 'acl')) {
      process.stderr.write(`vault-headers-helper: refused by the vault allowlist for this agent: "${vaultId}"\n`)
      continue
    }
  } else if (!unsendable || !dashboardConfigured(projectRoot)) {
    // with a dashboard token file (the warning fallback) an unsendable id counts as missing here too
    secret = getSecret(vaultId)
  }
  if (secret === null) {
    process.stderr.write(`vault-headers-helper: vault secret "${vaultId}" not found\n`)
    continue
  }
  headers[headerName] = scheme ? `${scheme} ${secret}` : secret
}

process.stdout.write(JSON.stringify(headers))
