// CHANNELUNCONF1110 (GROMZONOPROVIDER1108 / Samu 75055, 75584): is the main agent's primary channel configured?
// The TS twin of scripts/main-channel-configured.sh (channels.sh, channel-watchdog.sh, stuck-modal-guard.sh,
// verify-channels-health.sh); a test runs both on the same fixture dirs.
//
// A token provider (telegram, discord, slack, teams) with no token used to launch the main session with its
// `--channels plugin:<provider>` anyway; the plugin exits at once, so channels.sh's never-started guard restarted the
// session every 600/1200/2400 s forever and the dashboard's main-down ladder hard-restarted on top (owner VPS
// 11-07/08: 13-14 restarts overnight). Now such a session runs WITHOUT its primary channel ("unconfigured"),
// channels.sh writes store/.channel-unconfigured, nothing here restarts it or types into it, and the overview says
// that no channel is configured.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readChannelToken, resolveMainChannelStateDir, type ChannelProviderType } from '../channel-provider.js'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'

/** The providers this rule covers, with the .env key whose presence makes the channel configured. Every other
 *  provider (gromzo, googlechat, an unknown one) is never "unconfigured" here: its launch path stays as it was. */
export const MAIN_CHANNEL_TOKEN_KEYS: Readonly<Record<string, string>> = Object.freeze({
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  teams: 'TEAMS_BOT_APP_ID',
})

/** The marker channels.sh writes when it launched an unconfigured session (the provider on one line). */
export const MAIN_CHANNEL_UNCONFIGURED_MARKER = join(STORE_DIR, '.channel-unconfigured')

/** The launch rule (the shell twin's main_channel_unconfigured): true when the provider needs a token and none is set
 *  in the install-scoped .env, or in the legacy ~/.claude one while only that exists (channels.sh migrates it). The
 *  per-provider key and the whole-line match are readChannelToken's own. The state-dir env override is NOT read:
 *  channels.sh sets its own, so the launch never follows an inherited one. */
export function mainChannelUnconfigured(
  provider: string,
  opts: { installRoot?: string; home?: string } = {},
): boolean {
  if (!Object.prototype.hasOwnProperty.call(MAIN_CHANNEL_TOKEN_KEYS, provider)) return false
  const dir = resolveMainChannelStateDir({
    envOverride: undefined,
    installScoped: join(opts.installRoot ?? PROJECT_ROOT, '.claude', 'channels', provider),
    legacy: join(opts.home ?? homedir(), '.claude', 'channels', provider),
    hasEnvFile: (d) => existsSync(join(d, '.env')),
  })
  const token = readChannelToken(provider as ChannelProviderType, join(dir, '.env'))
  return !token
}

/** How the RUNNING session stands: the provider channels.sh launched without its channel, or null. A marker whose
 *  provider is not one this rule covers (hand-written, stale from another layout) counts as absent. */
export function readMainChannelUnconfiguredMarker(path: string = MAIN_CHANNEL_UNCONFIGURED_MARKER): string | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  const provider = raw.split('\n')[0]?.trim() ?? ''
  return Object.prototype.hasOwnProperty.call(MAIN_CHANNEL_TOKEN_KEYS, provider) ? provider : null
}

/** The monitor's question: does the RUNNING main session stand without its channel by design? Both must say so: the
 *  marker channels.sh wrote at the launch AND the launch rule now. Any process can write a file, so a false or stale
 *  marker alone never switches the main agent's liveness action off while its token is there (Dani #2691 K1). */
export function mainSessionRunsUnconfigured(
  provider: string,
  opts: { markerPath?: string; installRoot?: string; home?: string } = {},
): boolean {
  return readMainChannelUnconfiguredMarker(opts.markerPath) === provider && mainChannelUnconfigured(provider, opts)
}
