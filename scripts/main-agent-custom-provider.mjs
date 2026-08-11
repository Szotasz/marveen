#!/usr/bin/env node
// Resolve the MAIN channels-agent's custom provider and print the shell env
// prefix for channels.sh to inject into the tmux launch command.
//
// Output contract (consumed by scripts/channels.sh):
//   Exit 0, empty stdout  -- no customProvider is set; channels.sh carries on
//                            with standard Claude/OAuth auth. Legitimate no-op.
//   Exit 0, non-empty     -- provider fully resolved; channels.sh injects the
//                            printed env prefix into the tmux new-session call.
//   Exit 1, empty stdout  -- customProvider IS set but cannot be used (missing
//                            definition, missing vault key, invalid baseUrl …).
//                            channels.sh treats this as a hard error and aborts
//                            so the main agent does NOT silently fall back to a
//                            wrong backend.
//
// Side effect: for x-api-key providers the API key is pre-stamped into the
// config dir's .claude.json (stampCustomApiKeyApproval) so the "Detected a
// custom API key" TUI approval dialog never blocks --channels startup.
//
// Usage: node scripts/main-agent-custom-provider.mjs [claude-config-dir]
//   claude-config-dir: optional path to an isolated CLAUDE_CONFIG_DIR
//     (the stamped approval lands there instead of ~/.claude.json)
//
// NOTE (MEDIUM-5 / known): the auth credential is emitted as a shell export in
// the tmux new-session command string, making it visible in `ps`/`/proc`
// cmdline -- the same exposure as the existing CFG_ENV / CLAUDE_CODE_OAUTH_TOKEN
// export in channels.sh. Out-of-band delivery (tmux set-environment before
// new-session, or an env-file) would eliminate the exposure but requires a
// larger channels.sh refactor that is out of scope for this change.

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const { MAIN_AGENT_ID } = await import(join(projectRoot, 'dist', 'config.js'))
const { readAgentCustomProvider, readAgentModel } = await import(
  join(projectRoot, 'dist', 'web', 'agent-config.js')
)
const { loadCustomProvider } = await import(
  join(projectRoot, 'dist', 'web', 'custom-providers.js')
)
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))
const { stampCustomApiKeyApproval } = await import(
  join(projectRoot, 'dist', 'web', 'agent-process.js')
)

// POSIX single-quote-escape: wraps the value in single quotes and escapes any
// embedded single-quotes via the '"'"' sequence. Safe against ALL shell
// metacharacters (" $ ` \ newline etc.) in the tmux new-session command string.
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

// Hard-error helper: write to stderr, exit 1 so channels.sh aborts instead of
// silently falling back to the wrong (standard Claude/OAuth) backend.
const fatal = (msg) => {
  process.stderr.write(`main-agent-custom-provider: ${msg}\n`)
  process.exit(1)
}

const customProviderId = readAgentCustomProvider(MAIN_AGENT_ID)
// Legitimate no-op: no customProvider configured -> standard Claude/OAuth path.
if (!customProviderId) process.exit(0)

// From here on: customProvider IS configured, so any failure is a hard error.

const def = loadCustomProvider(customProviderId)
if (!def) {
  fatal(`provider "${customProviderId}" not found in store -- add it in Settings > Providers`)
}

const baseUrl = (def.baseUrl ?? '').trim()
if (!baseUrl) {
  fatal(`provider "${customProviderId}" has an empty baseUrl -- edit it in Settings > Providers`)
}

// readAgentModel falls back to DISTRIBUTION_DEFAULT_AGENT_MODEL, so the
// result is almost always non-empty. Guard defensively in case a future code
// change removes that fallback.
const model = (readAgentModel(MAIN_AGENT_ID) ?? '').trim()
if (!model) {
  fatal(`no model configured for main agent with customProvider "${customProviderId}" -- set a model via the dashboard`)
}

// Resolve auth credential from the vault.
let headerExport = ''      // exports the active auth credential
let unsetConflict = ''     // unsets the OTHER auth env so exactly one is active
let apiKeyForStamp = null

if (def.authHeader === 'none') {
  // Ollama-style: no real credential, use the sentinel token.
  // Unset any inherited ANTHROPIC_API_KEY so it does not override the
  // sentinel (Claude CLI prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN).
  headerExport = 'export ANTHROPIC_AUTH_TOKEN=ollama && '
  unsetConflict = 'unset ANTHROPIC_API_KEY && '
} else {
  const key = (getSecret(def.vaultKey ?? '') ?? '').trim()
  if (!key) {
    fatal(`vault key "${def.vaultKey}" missing for provider "${customProviderId}" -- add it in the Vault tab`)
  }
  if (def.authHeader === 'x-api-key') {
    headerExport = `export ANTHROPIC_API_KEY=${sq(key)} && `
    unsetConflict = 'unset ANTHROPIC_AUTH_TOKEN && '
    apiKeyForStamp = key
  } else {
    // Bearer
    headerExport = `export ANTHROPIC_AUTH_TOKEN=${sq(key)} && `
    unsetConflict = 'unset ANTHROPIC_API_KEY && '
  }
}

// Pre-stamp x-api-key approval into .claude.json so the TUI approval gate
// never fires at startup in --channels mode.
const claudeConfigDir = process.argv[2] || ''
const dotClaudePath = claudeConfigDir
  ? join(claudeConfigDir, '.claude.json')
  : join(homedir(), '.claude.json')

if (apiKeyForStamp) {
  try {
    stampCustomApiKeyApproval(dotClaudePath, apiKeyForStamp)
  } catch (e) {
    process.stderr.write(
      `main-agent-custom-provider: stampCustomApiKeyApproval failed (${e.message}) -- the TUI may show an approval dialog\n`,
    )
  }
}

// Output the env prefix:
//   1. Unset the inherited fleet OAuth token FIRST. The tmux server carries it
//      in the global env; every new session inherits it. The Claude CLI prefers
//      CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN,
//      so the inherited token would be sent to the custom endpoint -> 401.
//   2. Export baseUrl, auth credential, model. ANTHROPIC_MODEL is authoritative
//      for non-Claude model ids: the TUI validates --model against the Anthropic
//      catalog and silently falls back for unknown values, but ANTHROPIC_MODEL
//      bypasses that gate entirely.
//   3. Unset the conflicting auth var so exactly ONE auth mechanism is active.
process.stdout.write(
  `unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL=${sq(baseUrl)} && ${headerExport}${unsetConflict}export ANTHROPIC_MODEL=${sq(model)} && `,
)
