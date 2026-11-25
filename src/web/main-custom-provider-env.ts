// HOSTINGERRETEST1125: the main agent's custom provider (the Hostinger AI Router, or any other) on the IN-PROCESS
// respawns. channels.sh puts the provider env into the cold launch (scripts/main-agent-custom-provider.mjs). The
// dashboard's respawn-pane paths (the hard restart, the --continue resume, the fresh respawn) built their command
// without it. On Linux the hard restart IS a respawn-pane, not a channels.sh rerun, so a dashboard restart, and the
// restart after the wizard's router step, started the main agent on a Claude login the install does not have.
// The same helper runs here, so the cold launch and the respawn cannot drift apart.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { readAgentCustomProvider } from './agent-config.js'

const HELPER = join(PROJECT_ROOT, 'scripts', 'main-agent-custom-provider.mjs')

/** The provider is configured but cannot be used: the respawn must not start on the wrong backend (channels.sh aborts too). */
export class MainCustomProviderBroken extends Error {
  readonly code = 'custom-provider-broken'
}

export interface CustomProviderEnvDeps {
  provider: () => string | null
  /** Runs the helper; returns its stdout, throws on a non-zero exit (execFileSync's behaviour). */
  runHelper: (args: string[]) => string
  dirExists: (p: string) => boolean
}

const liveDeps: CustomProviderEnvDeps = {
  provider: () => readAgentCustomProvider(MAIN_AGENT_ID),
  runHelper: (args) => execFileSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  dirExists: existsSync,
}

/**
 * The shell prefix that points the main agent at its custom provider (no trailing `&&`), or '' when it has none.
 * The key is never in the string: the helper writes it to a 0600 file and the prefix reads it with `$(cat ...)`.
 * Throws MainCustomProviderBroken when a provider is configured but the helper cannot produce its env.
 */
export function mainCustomProviderLaunchEnv(cfgDir: string | null, deps: CustomProviderEnvDeps = liveDeps): string {
  const provider = deps.provider()
  if (!provider) return ''
  // As channels.sh: the config dir only when it exists, so the helper stamps the key approval into the right .claude.json.
  const args = cfgDir && deps.dirExists(cfgDir) ? [cfgDir] : []
  let out: string
  try {
    out = deps.runHelper(args)
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr
    const why = typeof stderr === 'string' && stderr.trim() ? stderr.trim().split('\n').pop() : (err instanceof Error ? err.message : String(err))
    throw new MainCustomProviderBroken(`the main agent's custom provider "${provider}" is configured but cannot be used: ${why}`)
  }
  const env = out.trim().replace(/&&$/, '').trim()
  // An empty answer while a provider is configured is the helper's stale-dist fallback: launching on it would run the
  // main agent on the standard backend, the silent wrong-backend launch channels.sh aborts on.
  if (!env) throw new MainCustomProviderBroken(`the main agent's custom provider "${provider}" is configured but the launch helper gave no env`)
  return env
}
