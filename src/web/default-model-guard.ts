// DEFAULTCLIGUARD927: the launch-time guard on the DEFAULT model path.
//
// DISTRIBUTION_DEFAULT_AGENT_MODEL is what every model-less main agent,
// model-less sub-agent, worker session and model-less agent-create runs after
// a plain code update (MODELMIGRATE806). The picker gate (PICKERCLIKAPU923,
// refuseIfCliCannotLaunch) only guards explicit WRITES; nothing on the default
// path consulted the CLI table, so a bump to a tier the installed CLI cannot
// run (the AVX-less 2.1.110 pin, or any older CLI kept in place by
// DISABLE_AUTOUPDATER) brought the session up and answered every prompt with
// 400 unrecognized_model -- a silent bot, no launch error.
//
// Callers reach for this ONLY when no explicit value resolved: MAIN_AGENT_MODEL,
// a settings.json model, an agent's own model/profile and a configured
// DEFAULT_AGENT_MODEL are the operator's choice and pass through untouched.
// Fail-open like the picker: an unmeasured CLI version changes nothing.
// The shell twin of this decision lives in scripts/channels.sh
// (resolve_main_model); main-model-resolution-parity.test.ts keeps them equal.
import { DEFAULT_AGENT_MODEL, DEFAULT_AGENT_MODEL_IS_DISTRIBUTION } from '../config.js'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL, DISTRIBUTION_DEFAULT_FALLBACK_MODEL } from '../config-registry.js'
import { launchableDefaultModel } from '../claude-cli-support.js'
import { measureClaudeCliVersion, measureClaudeCliVersionSync } from './claude-cli-version.js'
import { logger } from '../logger.js'

// One named line per surface and CLI version, not one per call: the sync
// resolver also feeds the status page, which polls.
const logged = new Set<string>()

function decide(installedVersion: string | null, surface: string): string {
  const d = launchableDefaultModel(DISTRIBUTION_DEFAULT_AGENT_MODEL, DISTRIBUTION_DEFAULT_FALLBACK_MODEL, installedVersion)
  if (d.replaced) {
    const key = `${surface}|${installedVersion}`
    if (!logged.has(key)) {
      logged.add(key)
      logger.warn(
        { surface, distributionDefault: d.replaced, minCli: d.minCli, installedCli: installedVersion, launched: d.model },
        'DEFAULTCLIGUARD927: the installed Claude Code CLI cannot launch the distribution default; this model-less launch falls back to the previous tier',
      )
    }
  }
  return d.model
}

/** The distribution default, or its fallback tier when the installed CLI is measured not to launch it. */
export function launchableDistributionDefaultSync(surface: string): string {
  return decide(measureClaudeCliVersionSync().version, surface)
}

/**
 * DEFAULT_AGENT_MODEL for a launch that resolved no model of its own. A
 * configured DEFAULT_AGENT_MODEL is returned as is; only the shipped default
 * is guarded. `fresh` bypasses the version cache (the agent-create path, so a
 * CLI upgraded a minute ago is not answered from a stale reading).
 */
export async function launchableInstallDefault(surface: string, opts: { fresh?: boolean } = {}): Promise<string> {
  if (!DEFAULT_AGENT_MODEL_IS_DISTRIBUTION) return DEFAULT_AGENT_MODEL
  return decide((await measureClaudeCliVersion({ fresh: opts.fresh })).version, surface)
}

/** Synchronous launchableInstallDefault, for the sync worker-session start. */
export function launchableInstallDefaultSync(surface: string): string {
  if (!DEFAULT_AGENT_MODEL_IS_DISTRIBUTION) return DEFAULT_AGENT_MODEL
  return launchableDistributionDefaultSync(surface)
}

/** Test hook: forget which fallback lines were already logged. */
export function resetDefaultModelGuardLog(): void { logged.clear() }
