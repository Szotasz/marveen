import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR, CHANNEL_PROVIDER, MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { resolveFromPath } from '../../platform.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { channelStateDir, readChannelToken } from '../../channel-provider.js'
import { sessionExistsOnHost } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { getClaudePidForSession, hasChannelPluginAlive } from '../../channel-coordinator/liveness.js'
import {
  hardRestartMarveenChannels,
  mainChannelsSessionExists,
  createMainChannelsSession,
} from '../channel-monitor.js'
import { liveProbeAuth, stampTokenVerified } from '../claude-credentials-guard.js'
import { json, readBody } from '../http-helpers.js'
import { isManagedSettingsReady, getManagedSettingsSudoCommand } from './agents.js'
import type { RouteContext } from './types.js'

// First-run onboarding for the "pre-install now, configure later" flow: the
// dashboard boots without Claude auth / channels, and the operator finishes
// setup from the UI (Claude token -> launch agents -> bot token -> pairing)
// instead of SSH + .env edits. All endpoints sit behind the dashboard token.

const ENV_FILE = join(PROJECT_ROOT, '.env')
const HOME_CREDENTIALS = join(homedir(), '.claude', '.credentials.json')
const FLEET_TOKEN_FILE = join(STORE_DIR, '.claude-oauth-token')

function readEnvValue(key: string): string | null {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      if (line.startsWith(key + '=')) {
        const v = line.slice(key.length + 1).trim()
        return v.length > 0 ? v : null
      }
    }
  } catch { /* no .env yet */ }
  return null
}

// True auth presence -- an env OAuth token / API key, a real credentials.json
// OAuth credential, or (macOS) the login Keychain credential. NOT merely "the
// .env line exists" (it could be empty).
//
// The Keychain leg matters: on macOS Claude Code stores the subscription login
// in the login Keychain and writes NO ~/.claude/.credentials.json, so a fully
// authenticated fleet looked logged-out to the wizard and the dashboard nagged
// for a token that would have created a second, drifting credential path.
// The probe is presence-only: no `-w`, so the credential secret itself never
// enters this process just to answer a yes/no question. It fails closed (false
// off macOS / on any lookup error), so a Keychain ACL that refused `security`
// just falls back to the previous behaviour.
function keychainHasClaudeCredentials(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username],
      { timeout: 3000, stdio: 'ignore' },
    )
    return true
  } catch { return false }
}

// The fleet setup-token leg (#654): the wizard's own auth step stores the
// token into FLEET_TOKEN_FILE (see the /api/onboarding/claude-auth handler
// below), so an install authenticated ONLY via the fleet token has no env
// var, no ~/.claude/.credentials.json and no Keychain entry -- without this
// check the wizard re-nagged on every reload right after completing itself.
// Presence-only, non-empty, same spirit as the other legs.
function fleetTokenPresent(): boolean {
  try {
    return readFileSync(FLEET_TOKEN_FILE, 'utf-8').trim().length > 0
  } catch { return false }
}

// Behaviour leg (last resort): a RUNNING fleet is authenticated even when none
// of the storage locations above hold the credential. channels.sh exports the
// setup-token into the tmux server's GLOBAL environment (`set-environment -g`,
// verified live 2026-08-09), which is the actual auth source of every session it
// spawns -- independent of .env, the fleet file, credentials.json or the
// Keychain. So a fresh install whose token reached the running session by any
// path (isolated CLAUDE_CONFIG_DIR, an env exported before .env was written, a
// timing race between the restart and the .env flush) still reads as logged-in.
// This asks the BEHAVIOUR ("is the running fleet carrying auth?") instead of
// enumerating storage types -- a storage-only check re-breaks on every new
// credential path; this one does not. Fails closed on any error (tmux
// unresolved, session gone), so it can only ever ADD a true, never flip one.
//
// PRESENCE-ONLY, NOT VALIDITY (read this before hardening): this proves the
// token is PRESENT in the tmux global env, NOT that it is valid or unexpired. It
// deliberately does NOT run a live probe (that is the expensive `claude -p` path
// this status check must avoid). The failure direction therefore INVERTS: before
// this leg a working install read as logged-out (false negative); with it, a
// machine still running on an expired/revoked token could read as authenticated
// (false positive) -- the same class BOOTPASS807 just tightened. Accepted on
// purpose because the leg is last-resort (only runs when every storage leg is
// false), and it is cheaper to be wrong this way than to keep telling every new
// customer their working product failed. A validity check (a cheap liveness
// signal, or gating on a fresh successful-auth log line) is deferred to a
// separate hardening card, NOT bolted on here. The token value is matched with a
// regex only -- never captured, returned, or logged.
function runningSessionAuthenticated(): boolean {
  try {
    if (!sessionExistsOnHost(null, MAIN_CHANNELS_SESSION)) return false
    const out = execFileSync(resolveFromPath('tmux'), ['show-environment', '-g'], {
      timeout: 3000, encoding: 'utf-8',
    })
    return /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+/m.test(out)
  } catch { return false }
}

function claudeAuthPresent(): boolean {
  if (readEnvValue('CLAUDE_CODE_OAUTH_TOKEN')) return true
  if (readEnvValue('ANTHROPIC_API_KEY')) return true
  try {
    const d = JSON.parse(readFileSync(HOME_CREDENTIALS, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string }; apiKey?: string
    }
    if (d?.claudeAiOauth?.accessToken) return true
    if (d?.apiKey) return true
  } catch { /* no / unreadable credentials.json */ }
  if (fleetTokenPresent()) return true
  if (keychainHasClaudeCredentials()) return true
  return runningSessionAuthenticated()
}

// Active-channel checks, provider-aware (NOT hardcoded to Telegram). A
// Discord-switched (or Slack/etc.) install has no telegram/ state dir, so a
// telegram-only probe would report "not configured" forever and pop the wizard
// over a working dashboard. readChannelToken knows each provider's env key.
//
// Slack also needs the managed-settings.json plugin allowlist (see isManagedSettingsReady in agents.ts) before its
// channel session can ever come up. A token saved on a machine where that allowlist is still missing
// must NOT read as "configured" -- otherwise step 3 skips straight to Pairing, the wizard never re-surfaces the 
// sudo-command prompt (it only fires from the step-3 save handler), and the operator is left staring at
// an empty pairing list with no explanation for why Slack never connects.
function channelConfigured(): boolean {
  const hasToken = readChannelToken(CHANNEL_PROVIDER, join(channelStateDir(CHANNEL_PROVIDER), '.env')) != null
  if (!hasToken) return false
  if (CHANNEL_PROVIDER === 'slack') return isManagedSettingsReady()
  return true
}

// Step 3 pre-fill: a bot (and, for Slack, app) token can already sit in the provider's .env from a prior save whose
// managed-settings.json gate wasn't satisfied yet (channelConfigured() reads that as "not configured"  -- see the
// comment above it). Without this the operator has to dig the token back out of ~/.claude/channels/<provider>/.env
// and repaste it just to get past a  step that already has it on disk. Presence-only elsewhere in this file stays
// presence-only; this is the one spot that hands the value back, and only to the already dashboard-token-gated status
// endpoint the operator is looking at.
function existingChannelTokens(): { botToken: string | null; appToken: string | null } {
  const envPath = join(channelStateDir(CHANNEL_PROVIDER), '.env')
  const botToken = readChannelToken(CHANNEL_PROVIDER, envPath)
  let appToken: string | null = null
  if (CHANNEL_PROVIDER === 'slack') {
    try {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        if (line.startsWith('SLACK_APP_TOKEN=')) {
          const v = line.slice('SLACK_APP_TOKEN='.length).trim()
          appToken = v.length > 0 ? v : null
          break
        }
      }
    } catch { /* no .env yet */ }
  }
  return { botToken, appToken }
}

function paired(): boolean {
  try {
    const a = JSON.parse(readFileSync(join(channelStateDir(CHANNEL_PROVIDER), 'access.json'), 'utf-8')) as {
      allowFrom?: unknown[]; groups?: Record<string, unknown>
    }
    const allow = Array.isArray(a.allowFrom) ? a.allowFrom.length : 0
    const groups = a.groups && typeof a.groups === 'object' ? Object.keys(a.groups).length : 0
    return allow > 0 || groups > 0
  } catch { return false }
}

function agentsRunning(): boolean {
  try { return sessionExistsOnHost(null, MAIN_CHANNELS_SESSION) } catch { return false }
}

// Atomic, idempotent .env update for one key: drop any prior line for the key,
// keep every other line verbatim, append the new value, chmod 600. Never sed.
function setEnvKey(key: string, value: string): void {
  let lines: string[] = []
  try { lines = readFileSync(ENV_FILE, 'utf-8').split('\n') } catch { /* fresh .env */ }
  const kept = lines.filter((l) => l.length > 0 && !l.startsWith(key + '='))
  kept.push(`${key}=${value}`)
  atomicWriteFileSync(ENV_FILE, kept.join('\n') + '\n', { mode: 0o600 })
}

// Replace every standalone occurrence of `from` with `to` in a persona file
// (CLAUDE.md / SOUL.md). Plain global string replace -- the persona files are
// generated from templates where the name appears verbatim. Atomic write, and
// a no-op when the file is missing or nothing matched.
function renameInPersonaFile(file: string, from: string, to: string): void {
  if (!from || !to || from === to) return
  let content: string
  try { content = readFileSync(file, 'utf-8') } catch { return }
  if (!content.includes(from)) return
  atomicWriteFileSync(file, content.split(from).join(to))
}

function identityConfirmed(): boolean {
  return readEnvValue('IDENTITY_CONFIRMED') === '1'
}

// Pure decision core of the identity save. BOT_NAME is always written (it is
// display-only -- measured 2026-07-28, WIZNAME1: every tmux/unit/DB key
// resolves from MAIN_AGENT_ID/SERVICE_ID, never from BOT_NAME). The channels
// session is bounced only when ALL THREE hold: the fleet is up, the install is
// genuinely mid-first-run-setup (freshSetup: auth/channel/pairing not yet all
// in place -- the same probes the wizard itself gates on), and the display
// name actually changed. freshSetup deliberately does NOT mean "the
// IDENTITY_CONFIRMED flag is absent": a pre-wizard-era install lacks the flag
// too, and its running session is a long-lived working agent, not setup state
// -- bouncing it would cost real context (#758 review). Such installs, and any
// configured install, get restartNeeded instead; a no-op save (name unchanged)
// never triggers either.
export function identitySavePlan(
  servicesUp: boolean,
  freshSetup: boolean,
  nameChanged: boolean,
): { restart: boolean; restartNeeded: boolean } {
  return {
    restart: servicesUp && freshSetup && nameChanged,
    restartNeeded: servicesUp && !freshSetup && nameChanged,
  }
}

export async function tryHandleOnboarding(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Onboarding state so the frontend knows which step to show.
  if (path === '/api/onboarding/status' && method === 'GET') {
    const claude = claudeAuthPresent()
    const running = agentsRunning()
    const ch = channelConfigured()
    const pr = paired()
    // Only surface an already-saved token while step 3 (channel setup) is the one still pending --  once the
    // channel is configured there is nothing to pre-fill and no reason to hand the value back over the wire.
    const existingTokens = !ch ? existingChannelTokens() : { botToken: null, appToken: null }
    // Slack pre-flight, surfaced passively (GET, no probe/write/restart): when  a token is already on disk
    // but the managed-settings.json plugin allowlist isn't, the wizard can show the sudo command immediately
    // instead of making the operator hit Save just to learn it's needed. Kept null whenever there's nothing to
    // say (no provider/no token/already ready), so the frontend's check stays a single truthiness test.
    const managedSettingsReady = CHANNEL_PROVIDER === 'slack' && existingTokens.botToken
      ? isManagedSettingsReady()
      : null
    const sudoCommand = managedSettingsReady === false ? getManagedSettingsSudoCommand() : null
    // WIZFLOW809: measured channel liveness for the wizard's step-3 wait.
    // hardRestartMarveenChannels() answers `restarted: true` when the restart
    // COMMAND was dispatched, not when the channel is up -- and the cold path
    // is a ~minutes start. The wizard used to advance after a fixed 4s and
    // opened the pairing step against a still-booting session (three field
    // reports, WIZFLOW809). This field is the ready signal it waits on now:
    // the same bun-child/process liveness definition channel-monitor and
    // channel-plugin-unlock already agree on. Fail-closed: any probe error
    // reads as "not live yet" -- the wizard just keeps waiting.
    let channelLive = false
    try {
      const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
      channelLive = claudePid != null && hasChannelPluginAlive(claudePid, CHANNEL_PROVIDER)
    } catch {
      channelLive = false
    }
    json(res, {
      identityConfirmed: identityConfirmed(),
      currentAgentName: readEnvValue('BRAND_NAME') || readEnvValue('BOT_NAME') || 'Marveen',
      currentOwnerName: readEnvValue('OWNER_NAME') || '',
      claudeAuthPresent: claude,
      agentsRunning: running,
      channelConfigured: ch,
      channelLive,
      channelProvider: CHANNEL_PROVIDER,
      agentId: MAIN_AGENT_ID,
      existingBotToken: existingTokens.botToken,
      existingAppToken: existingTokens.appToken,
      managedSettingsReady,
      sudoCommand,
      paired: pr,
      // The identity step never re-opens the wizard on an already-configured
      // install: it only participates while first-run setup is incomplete.
      needsOnboarding: !claude || !running || !ch || !pr,
    })
    return true
  }

  // Identity step: agent display name + owner name. SAFETY: MAIN_AGENT_ID and
  // SERVICE_ID are baked into the plumbing at install time (tmux session name,
  // DB rows, OS service-unit names) -- rewriting THOSE after the services exist
  // orphans running units and can lock the owner out, so this handler never
  // touches them. BOT_NAME however is display-only (measured 2026-07-28,
  // WIZNAME1: every session/unit/DB key resolves from MAIN_AGENT_ID/SERVICE_ID;
  // BOT_NAME feeds labels, message prefixes and persona prose), so it is always
  // written -- the old !servicesUp guard silently dropped the rename on every
  // installer-started (VPS) setup, where the wizard runs with the fleet already
  // up. Because a running process never re-reads .env, a first-run save with
  // the fleet up also restarts the channels session (same rule as the
  // claude-auth step: the session is freshly spawned setup state, bouncing it
  // loses nothing). A re-save on an already-confirmed install keeps the
  // no-implicit-restart-of-a-working-fleet behaviour and reports
  // restartNeeded instead.
  if (path === '/api/onboarding/identity' && method === 'POST') {
    let body: { agentName?: string; ownerName?: string } = {}
    try { body = JSON.parse((await readBody(req)).toString()) as typeof body } catch { /* empty */ }
    const agentName = (body.agentName ?? '').trim()
    const ownerName = (body.ownerName ?? '').trim()
    if (!agentName || !ownerName) { json(res, { error: 'agentName es ownerName szukseges.', reason: 'missing' }, 400); return true }
    if (agentName.length > 40 || ownerName.length > 60 || /[\n\r\0=]/.test(agentName + ownerName)) {
      json(res, { error: 'A nev tul hosszu vagy tiltott karaktert tartalmaz.', reason: 'bad-name' }, 400)
      return true
    }

    const servicesUp = agentsRunning()
    // Genuine first-run-setup signal: the same probes the wizard gates on.
    // NOT the IDENTITY_CONFIRMED flag -- a pre-wizard-era install lacks that
    // flag while its running session is a live working agent (#758 review).
    const freshSetup = !claudeAuthPresent() || !channelConfigured() || !paired()
    const prevAgentName = readEnvValue('BOT_NAME') || 'Marveen'
    const prevOwnerName = readEnvValue('OWNER_NAME') || ''
    const nameChanged = agentName !== prevAgentName
    try {
      setEnvKey('OWNER_NAME', ownerName)
      setEnvKey('BRAND_NAME', agentName)
      setEnvKey('BOT_NAME', agentName)
      setEnvKey('IDENTITY_CONFIRMED', '1')
    } catch (err) {
      logger.error({ err }, 'onboarding: failed to persist identity to .env')
      json(res, { error: 'Nem sikerult elmenteni az .env-be.', reason: 'write-failed' }, 500)
      return true
    }

    // Persona files: the agent introduces itself by this name. Never touches
    // owner/access config, only the two persona documents.
    try {
      for (const f of [join(PROJECT_ROOT, 'CLAUDE.md'), join(PROJECT_ROOT, 'SOUL.md')]) {
        renameInPersonaFile(f, prevAgentName, agentName)
        if (prevOwnerName) renameInPersonaFile(f, prevOwnerName, ownerName)
      }
    } catch (err) {
      logger.warn({ err }, 'onboarding: persona rename failed (identity saved to .env regardless)')
    }

    // A running session never re-reads .env or its spawn-time persona, so a
    // mid-setup save with the fleet already up (the installer-started VPS
    // path) bounces the channels session to pick the name up -- setup state
    // only, nothing to lose. On a configured (or pre-wizard legacy) install we
    // never implicitly restart a working fleet; the wizard copy surfaces
    // restartNeeded instead, and a no-op save restarts nothing.
    let restarted = false
    let restartError: string | null = null
    const plan = identitySavePlan(servicesUp, freshSetup, nameChanged)
    const restartNeeded = plan.restartNeeded
    if (plan.restart) {
      const r = hardRestartMarveenChannels()
      restarted = r.ok
      if (!r.ok) restartError = r.error || 'restart failed'
      if (r.ok) logger.info('onboarding: channels restarted so the new identity is picked up')
      else logger.error({ error: restartError }, 'onboarding: channels restart after identity save FAILED')
    }
    logger.info({ servicesUp, freshSetup, nameChanged, restarted, botNameUpdated: true }, 'onboarding: identity configured')
    json(res, {
      ok: true,
      botNameUpdated: true,
      restarted,
      ...(restartError ? { restartError } : {}),
      ...(restartNeeded ? { restartNeeded } : {}),
    })
    return true
  }

  // Store a Claude setup-token (OAuth) or API key. The value is NEVER logged or
  // echoed back -- only { ok, verified }. Zero owner/access-config clobber.
  if (path === '/api/onboarding/claude-auth' && method === 'POST') {
    let body: { token?: string; apiKey?: string } = {}
    try { body = JSON.parse((await readBody(req)).toString()) as typeof body } catch { /* empty */ }
    const token = (body.token ?? '').trim()
    const apiKey = (body.apiKey ?? '').trim()
    if (!token && !apiKey) { json(res, { error: 'token vagy apiKey szukseges.', reason: 'missing' }, 400); return true }
    if (token && !/^sk-ant-oat/.test(token)) { json(res, { error: 'A setup-token formatuma nem stimmel (sk-ant-oat...).', reason: 'bad-token' }, 400); return true }
    if (apiKey && !/^sk-ant-/.test(apiKey)) { json(res, { error: 'Az API-kulcs formatuma nem stimmel (sk-ant-...).', reason: 'bad-key' }, 400); return true }

    // Read BEFORE persisting: on a fresh install the channels session is
    // booted by the installer/service unit with NO credentials, so if the
    // install had no auth at this point, a running session is unauthenticated
    // by construction. That is the one case where this endpoint must restart
    // it after the save -- a running process never picks up new env.
    const hadAuthBefore = claudeAuthPresent()

    // Verify BEFORE persisting, with a REAL probe. 2026-07-15 bootcamp bug 3:
    // the old persist-then-verify order stored a mistyped/revoked token into
    // .env + the fleet token file and still returned ok:true -- and since
    // CLAUDE_CODE_OAUTH_TOKEN env strictly overrides a valid
    // ~/.claude/.credentials.json, that single bad paste 401-ed ("Invalid
    // bearer token") every sub-agent launched afterwards while the env-less
    // main agent kept working. NOTE: `claude auth status` is NOT a validator --
    // it exits 0 for a garbage token (it reports the auth source; proven live
    // on the reference VPS) -- so this uses liveProbeAuth (one tiny haiku
    // `claude -p` call). Only a probe that PROVES the credential dead blocks
    // the persist; an inconclusive probe (binary missing / network flake)
    // keeps the old best-effort behaviour and stores it as verified:false.
    const probe = await liveProbeAuth(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: apiKey })
    if (probe === 'auth-rejected') {
      logger.warn({ mode: token ? 'oauth' : 'apikey' }, 'onboarding: Claude auth REJECTED by live probe; nothing persisted')
      json(res, { error: 'A megadott token/kulcs nem ervenyes (a proba-hivast a szerver elutasitotta). Ellenorizd, hogy a teljes setup-tokent illesztetted-e be.', reason: 'verify-failed', verified: false }, 400)
      return true
    }
    const verified = probe === 'ok'

    try {
      if (token) {
        setEnvKey('CLAUDE_CODE_OAUTH_TOKEN', token)
        // Keep the credentials-guard fleet token file in sync (harmless if unused).
        try { mkdirSync(STORE_DIR, { recursive: true }); writeFileSync(FLEET_TOKEN_FILE, token, { mode: 0o600 }) } catch { /* optional */ }
        // A live-verified token needs no boot-time re-probe.
        if (verified) stampTokenVerified(token)
      } else {
        setEnvKey('ANTHROPIC_API_KEY', apiKey)
      }
    } catch (err) {
      logger.error({ err }, 'onboarding: failed to persist Claude auth to .env')
      json(res, { error: 'Nem sikerult elmenteni az .env-be.', reason: 'write-failed' }, 500)
      return true
    }
    // BK bootcamp 2026-07-28: the wizard's /launch guards on agentsRunning()
    // and short-circuits when the (unauthenticated) session already exists, so
    // the token saved here never reached the running process and the install
    // stayed logged-out. Restart here, in exactly the case where it is both
    // needed and safe: the install had NO auth before this save, so the
    // running session cannot be an authenticated live agent -- bouncing it
    // loses nothing. Re-pasting a token on an already-authenticated install
    // keeps today's behaviour (no implicit restart of a working fleet).
    let restarted = false
    let restartError: string | null = null
    if (!hadAuthBefore && agentsRunning()) {
      const r = hardRestartMarveenChannels()
      restarted = r.ok
      if (!r.ok) restartError = r.error || 'restart failed'
      if (r.ok) logger.info('onboarding: channels restarted so the fresh auth is picked up')
      else logger.error({ error: restartError }, 'onboarding: channels restart after first auth FAILED')
    }
    logger.info({ verified, restarted, mode: token ? 'oauth' : 'apikey' }, 'onboarding: Claude auth stored')
    json(res, restartError ? { ok: true, verified, restarted, restartError } : { ok: true, verified, restarted })
    return true
  }

  // Launch the fleet (main-agent channels session). Idempotent: no double-spawn.
  if (path === '/api/onboarding/launch' && method === 'POST') {
    if (agentsRunning()) { json(res, { ok: true, alreadyRunning: true }); return true }
    if (!claudeAuthPresent()) { json(res, { error: 'Eloszor allitsd be a Claude-autentikaciot.', reason: 'no-auth' }, 409); return true }
    // ONBTMUX1: on a fresh install the channels session does NOT exist yet, and
    // `tmux respawn-pane` (what hardRestartMarveenChannels does on Linux) cannot
    // bring back a session that was never there -- it fails with "respawn-pane
    // failed" and the wizard's step 2 dead-ends. When the session is ABSENT the
    // correct action is to CREATE it via channels.sh (createMainChannelsSession),
    // the same path the keep-alive monitor uses for a vanished session. Only a
    // session that EXISTS but is wedged should be respawn-paned.
    if (!mainChannelsSessionExists()) {
      // createMainChannelsSession kicks channels.sh detached (a ~minutes cold
      // start). 'started' and 'grace' (already kicked, still booting) are both
      // healthy "starting" states for the wizard's status poll. A missing or
      // unlaunchable channels.sh is a BROKEN INSTALL: reporting it as
      // "starting" would show the customer a success message over a fleet that
      // can never come up, so it must be a hard error the UI can name.
      const created = createMainChannelsSession()
      if (created === 'script-missing' || created === 'spawn-failed') {
        logger.error({ created }, 'onboarding: channels session absent and channels.sh could not be launched')
        json(res, {
          error: 'Az ügynökök indítása nem sikerült: a channels.sh nem futtatható. A telepítés sérült lehet -- futtasd újra a telepítőt, vagy nézd meg a store/channels-failures.log-ot.',
          reason: created === 'script-missing' ? 'channels-script-missing' : 'channels-spawn-failed',
        }, 500)
        return true
      }
      logger.info({ created }, 'onboarding: channels session absent -- creating via channels.sh')
      json(res, { ok: true, starting: true })
      return true
    }
    const r = hardRestartMarveenChannels()
    if (!r.ok) { json(res, { error: r.error || 'Nem sikerult eletre kelteni az agenteket.', reason: 'launch-failed' }, 500); return true }
    logger.info('onboarding: fleet launched (channels session)')
    json(res, { ok: true, started: true })
    return true
  }

  return false
}
