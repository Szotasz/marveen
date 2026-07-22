#!/usr/bin/env node
// Print the `--chrome ` flag fragment for scripts/channels.sh, or NOTHING.
//
// Why a helper and not an inline jq read: the setting resolves through the
// settings-store (dashboard override in store/config-overrides.json, then .env,
// then the registry default), and that resolution order lives in one place --
// the compiled dist. Mirrors main-agent-isolated-config.mjs and vault-resolve.mjs
// so there is a single source of truth rather than a second, shell-side copy of
// the precedence rules that could drift.
//
// Prints NOTHING (exit 0) when the setting is off, unreadable, or dist is absent.
// That is the strict no-op existing installs need: no setting, no dist, no change
// to the command line at all.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const { getEffectiveSettingValue } = await import(
    join(projectRoot, 'dist', 'settings-store.js')
  )
  if (String(getEffectiveSettingValue('MAIN_AGENT_CHROME')) === '1') {
    // Trailing space: the caller interpolates this straight into the command
    // string next to MODEL_FLAG, which uses the same convention.
    process.stdout.write('--chrome ')
  }
} catch {
  // Unbuilt tree, missing key, unreadable overrides -- stay silent. A failure to
  // read a preference must never change how the main agent starts.
}
