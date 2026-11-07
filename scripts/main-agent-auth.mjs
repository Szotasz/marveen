#!/usr/bin/env node
// MAINAUTH1107 (APIKULCSINDITAS1004 A): the main agent's credential for THIS launch, decided and applied by
// src/web/main-auth.ts (dist). Called by scripts/channels.sh at boot and by scripts/channel-watchdog.sh /
// scripts/stuck-modal-guard.sh right before their respawn-pane; the dashboard's own respawns call the module
// directly. Writes store/.channels-pane-auth, store/.channels-pane-auth-post, the stamp (+ ledger) and
// store/.main-auth-launched.
//
// Usage: main-agent-auth.mjs <config-dir mode> <config dir>
//   the mode and dir exactly as scripts/main-agent-isolated-config.mjs printed them (explicit|rotated|token|isolated,
//   or empty for the shared root).
//
// Output contract, on fd 3 (callers redirect `3>&1 2>>log 1>&2`, as for main-agent-isolated-config.mjs, so a log
// line the dist modules print can never reach the contract), ONE line:
//   main-auth<TAB><configured><TAB><effective><TAB><conflict or -><TAB><failed steps comma-joined, or ->
// One special line (VAULTUNREAD1107): api mode with an unreadable vault writes NOTHING and says
//   main-auth<TAB>api<TAB>kept<TAB>vault-unreadable<TAB>-
// so the caller keeps the previous decision's files and alerts, instead of mistaking it for a missing dist.
// Nothing at all when the dist modules cannot load: the caller then keeps its own fallback. Never a credential value.

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fstatSync, writeSync } from 'node:fs'

// The vault and logger modules must stay quiet and must not migrate the vault key here (vault-resolve.mjs:44-53).
process.env.LOG_LEVEL = 'silent'
process.env.MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION = '1'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

let CONTRACT_FD = 3
try { fstatSync(CONTRACT_FD) } catch { CONTRACT_FD = 1 }

let mod
try {
  mod = await import(join(projectRoot, 'dist', 'web', 'main-auth.js'))
} catch (e) {
  process.stderr.write(`main-agent-auth: dist module load failed (${e && e.message}) -- the caller keeps its fallback\n`)
  process.exit(0)
}

const [cfgMode = '', cfgDirArg = ''] = process.argv.slice(2)
const kind = mod.cfgKindFromHelperMode(cfgMode)
const cfgDir = kind === 'shared' ? null : (cfgDirArg || null)
try {
  const { decision, result } = mod.prepareMainAuth(kind, cfgDir)
  writeSync(CONTRACT_FD, ['main-auth', decision.configured, decision.effective, decision.conflict ?? '-', result.failed.length ? result.failed.join(',') : '-'].join('\t') + '\n')
} catch (e) {
  if (e && e.code === 'vault-unreadable') {
    writeSync(CONTRACT_FD, ['main-auth', 'api', 'kept', 'vault-unreadable', '-'].join('\t') + '\n')
    process.stderr.write(`main-agent-auth: ${e.message}\n`)
    process.exit(0)
  }
  process.stderr.write(`main-agent-auth: apply failed (${e && e.message}) -- the caller keeps its fallback\n`)
  process.exit(0)
}
