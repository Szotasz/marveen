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

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

// Same pattern as vault-resolve.mjs: import the compiled vault module.
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))

const headers = {}
for (const arg of process.argv.slice(2)) {
  const eq = arg.indexOf('=')
  if (eq < 0) continue
  const headerName = arg.slice(0, eq)
  const rest = arg.slice(eq + 1)
  const sep = rest.indexOf(':::')
  const scheme = sep >= 0 ? rest.slice(0, sep) : ''
  const vaultId = sep >= 0 ? rest.slice(sep + 3) : rest
  if (!headerName || !vaultId) continue
  const secret = getSecret(vaultId)
  if (secret === null) {
    process.stderr.write(`vault-headers-helper: vault secret "${vaultId}" not found\n`)
    continue
  }
  headers[headerName] = scheme ? `${scheme} ${secret}` : secret
}

process.stdout.write(JSON.stringify(headers))
