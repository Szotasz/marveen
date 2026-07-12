#!/usr/bin/env node
// Provision (idempotently) the MAIN channels-agent's isolated CLAUDE_CONFIG_DIR
// on macOS, then print its path on stdout so scripts/channels.sh can export it.
//
// Why: the main agent otherwise keeps the shared ~/.claude and, on macOS,
// authenticates from the ROTATING Keychain OAuth session -- which periodically
// expires and 401s the main bot (a manual /login is then needed). An isolated
// config dir (no .credentials.json) makes it authenticate from the long-lived
// fleet setup-token via CLAUDE_CODE_OAUTH_TOKEN, exactly like the sub-agents.
//
// Prints NOTHING (and exits 0) when isolation is not applicable -- non-macOS, no
// fleet token (store/.claude-oauth-token), or ~/.claude absent -- so the caller
// simply keeps the shared root. Mirrors vault-resolve.mjs: dynamic import from
// the compiled dist so there is a single source of truth (agent-process.ts).
//
// Usage: node scripts/main-agent-isolated-config.mjs [provider]
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const { ensureMainAgentIsolatedConfigDir } = await import(
  join(projectRoot, 'dist', 'web', 'agent-process.js')
)

const provider = process.argv[2] || undefined
const dir = ensureMainAgentIsolatedConfigDir(provider)
if (dir) process.stdout.write(dir + '\n')
