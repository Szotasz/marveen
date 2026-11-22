import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROJECT_ROOT, STORE_DIR, CHANNEL_PROVIDER, MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { resolveFromPath } from '../../platform.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { channelStateDir, readChannelToken } from '../../channel-provider.js'
import { sessionExistsOnHost } from '../agent-process.js'
import { channelsRestartCommand, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { getClaudePidForSession, hasChannelPluginAlive } from '../../channel-coordinator/liveness.js'
import {
  hardRestartMarveenChannels,
  mainChannelsSessionExists,
  createMainChannelsSession,
} from '../channel-monitor.js'
import { liveProbeAuth, stampTokenVerified } from '../claude-credentials-guard.js'
import { json, readBodyOrRefuse } from '../http-helpers.js'
import { isManagedSettingsReady, getManagedSettingsSudoCommand } from './agents.js'
import { mayActAsOwner, mayActAsOwnerOrFirstRun, refuseOwner, OWNER_SESSION_REQUIRED } from './auth.js'
import { assertEnvEntry } from '../../env.js'
import { mainGromzoPrimaryReady } from '../main-gromzo-launch.js'
import { teamsAllowlistIds, TEAMS_ALLOWLIST_FILE } from '../../owner-chat.js'
import type { RouteContext } from './types.js'
import { deployment } from '../deployment.js'
import { installLang, switchInstallLanguage, type RunResult } from '../install-lang-switch.js'
import {
  applyMainRouter, checkRouterKey, HOSTINGER_ROUTER_DEFAULT_MODEL, HOSTINGER_ROUTER_MODELS, resolveRouterModel, routerAuthPresent,
  routerAvailable,
} from '../hostinger-router.js'
import { writeAgentAuthMode } from '../agent-config.js'
import { deleteSecret } from '../vault.js'

// DOCKERUX1118: one language switch at a time.
let langSwitchBusy = false
// HOSTINGERI18N1122: a switch over the running setup session that failed after its first write (env, .lang, persona
// already in the new language), did not read back, or whose restart failed, owes the session its restart: the retry finds the language
// already switched (nothing to render) and pays it then.
let langRestartOwed = false
/** A program without a shell, with exactly the given environment; never rejects (a failure is a code). */
function runNoShell(file: string, args: readonly string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : null, stdout: stdout ?? '' })
    })
  })
}

const execFileAsync = promisify(execFile)

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
async function keychainHasClaudeCredentials(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const pending = execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username],
      { timeout: 3000 },
    )
    pending.child.stdin?.end()
    await pending
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
async function runningSessionAuthenticated(): Promise<boolean> {
  try {
    if (!sessionExistsOnHost(null, MAIN_CHANNELS_SESSION)) return false
    const pending = execFileAsync(resolveFromPath('tmux'), ['show-environment', '-g'], {
      timeout: 3000, encoding: 'utf-8',
    })
    pending.child.stdin?.end()
    const { stdout: out } = await pending
    return /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+/m.test(out)
  } catch { return false }
}

// OWNERGATE4-1104 (review, Samu 69637): the condition of the 'onboarding-claude-auth' first-run pass. True only when
// claudeAuthPresent finds no credential (no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in .env, no fleet token file,
// no credential in ~/.claude/.credentials.json, no Keychain entry, no token in the running session) AND none of the
// three files it reads exists while being unreadable (or, for credentials.json, not JSON). claudeAuthPresent treats
// such a file as absent; here it counts as a stored credential (fail closed: the strict gate applies).
async function noClaudeCredentialYet(): Promise<boolean> {
  for (const file of [ENV_FILE, FLEET_TOKEN_FILE, HOME_CREDENTIALS]) {
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return false
    }
    if (file === HOME_CREDENTIALS && raw.trim()) {
      try { JSON.parse(raw) } catch { return false }
    }
  }
  return !(await claudeAuthPresent())
}

async function claudeAuthPresent(): Promise<boolean> {
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
  // HOSTINGERROUTER1122 (Geri 82904): a router install has no Claude credential, but the main agent can run: its
  // customProvider is the router, the record exists and the key is in the vault. Otherwise the wizard sticks here.
  if (routerAuthPresent(MAIN_AGENT_ID)) return true
  if (await keychainHasClaudeCredentials()) return true
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
// GROMZONOPROVIDER1108: a gromzo install has no token and no access.json. Its channel is "configured" and "paired" once
// the main agent is enrolled in mxd (mainGromzoPrimaryReady: socket usable and its token file present): mxd issues that
// token only for an agent it runs, which needs the owner's consent in the Gromzo app, so the owner is the paired one.
function gromzoEnrolled(): boolean {
  return mainGromzoPrimaryReady(MAIN_AGENT_ID)
}

function channelConfigured(): boolean {
  if (CHANNEL_PROVIDER === 'gromzo') return gromzoEnrolled()
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

// TEAMSPAIRED1115: the Teams plugin (claude-channel-teams 0.3.0, src/pairing/allowlist.ts) keeps its paired users
// in <stateDir>/allowlist.json as {"version":1,"entries":[{"aad_object_id":"<uuid>",...}]} and writes no access.json.
// Paired = at least one entry with an object id; any other shape the plugin itself treats as empty.
// The parser is owner-chat.ts teamsAllowlistIds, shared with the owner-alert target (TEAMSAPPROVECARD1118).
function teamsPaired(): boolean {
  try {
    return teamsAllowlistIds(JSON.parse(readFileSync(join(channelStateDir('teams'), TEAMS_ALLOWLIST_FILE), 'utf-8'))).length > 0
  } catch { return false }
}

function paired(): boolean {
  if (CHANNEL_PROVIDER === 'gromzo') return gromzoEnrolled()
  if (CHANNEL_PROVIDER === 'teams') return teamsPaired()
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
  assertEnvEntry(key, value)
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

// ONBOARDNOTG1108 (b): the wizard's close ("x") is remembered on the machine, not in the browser. The dashboard used to
// keep it in localStorage, which is bound to the origin, and the Bridge opens the dashboard on a fresh local tunnel port
// on every connect (a new origin each time), so the wizard came back on every Bridge open. One flag file in the store:
// present = the owner closed the wizard. Only the owner sets or clears it (the routes below); the status reports it.
const ONBOARDING_DISMISSED_FILE = join(STORE_DIR, '.onboarding-dismissed')

export function onboardingDismissedOnServer(): boolean {
  try { return existsSync(ONBOARDING_DISMISSED_FILE) } catch { return false }
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
    const claude = await claudeAuthPresent()
    const running = agentsRunning()
    const ch = channelConfigured()
    const pr = paired()
    // Only surface an already-saved token while step 3 (channel setup) is the one still pending --  once the
    // channel is configured there is nothing to pre-fill and no reason to hand the value back over the wire.
    // DOCKERHTTPS1119 Dani n2 (81264): a setup session (the public listener before the first login) never gets a saved
    // channel token back; the wizard reaches the channel step only after the password, on the owner session.
    const existingTokens = !ch && ctx.auth?.kind !== 'setup' ? existingChannelTokens() : { botToken: null, appToken: null }
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
      // ONBOARDNOTG1108 (b): the owner closed the wizard (the machine's flag, whatever origin the dashboard is on).
      dismissed: onboardingDismissedOnServer(),
      // DOCKERUX1118: the wizard shows its language switch in the container only, and compares with the install's.
      deployment: deployment(),
      installLang: installLang(readEnvValue),
      // HOSTINGERROUTER1122: the router choice in the Claude step, only on a Hostinger install (never preselected).
      router: routerAvailable(PROJECT_ROOT)
        ? { available: true, models: [...HOSTINGER_ROUTER_MODELS], defaultModel: HOSTINGER_ROUTER_DEFAULT_MODEL }
        : { available: false },
    })
    return true
  }

  // ONBOARDNOTG1108 (b): the wizard's close, remembered on the machine. POST sets the flag, DELETE clears it (the auth
  // banner's "finish the setup" reopens the wizard). Owner-only: it hides the owner's setup wizard on every origin, so
  // a bare device key, an operator key or a sub-agent token may not set it. A refused caller keeps the browser-local
  // close (the dashboard still writes localStorage), which is the behaviour before this flag.
  if (path === '/api/onboarding/dismiss' && (method === 'POST' || method === 'DELETE')) {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Remembering the closed setup wizard on this machine needs the dashboard login (an owner session).' }, 403)
      return true
    }
    try {
      if (method === 'POST') {
        mkdirSync(STORE_DIR, { recursive: true })
        atomicWriteFileSync(ONBOARDING_DISMISSED_FILE, JSON.stringify({ dismissedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
      } else {
        rmSync(ONBOARDING_DISMISSED_FILE, { force: true })
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, method }, 'onboarding: the wizard close flag could not be written')
      json(res, { error: 'The setup wizard state could not be saved.', reason: 'write-failed' }, 500)
      return true
    }
    json(res, { ok: true, dismissed: onboardingDismissedOnServer() })
    return true
  }

  // DOCKERUX1118 (owner 33327/33329, Samu 80886/80891): the wizard's language switch. Docker only (a native install's
  // language is the installer's question); the owner session only, never the bare first-run token; only while the
  // setup is unfinished. A main agent already running is restarted after the switch (HOSTINGERI18N1122, below). What it
  // rewrites, and the untouched-only rule: src/web/install-lang-switch.ts.
  if (path === '/api/onboarding/language' && method === 'POST') {
    if (!mayActAsOwner(ctx.auth, req)) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Changing the install language needs the dashboard login (an owner session).' }, 403)
      return true
    }
    const raw = await readBodyOrRefuse(req, res)
    if (!raw) return true
    let lang: unknown
    try { lang = (JSON.parse(raw.toString()) as { lang?: unknown }).lang } catch { /* empty */ }
    if (lang !== 'en' && lang !== 'hu') { json(res, { error: 'lang must be "en" or "hu".', reason: 'bad-lang' }, 400); return true }
    if (deployment() !== 'docker') {
      json(res, { error: 'The install language is switched here only in the Docker container. This install chose its language when it was installed.', reason: 'not_docker' }, 409)
      return true
    }
    if (channelConfigured() && paired() && (await claudeAuthPresent())) {
      json(res, { error: 'The setup is finished: the install language can only be switched during the setup.', reason: 'onboarding_done' }, 409)
      return true
    }
    // HOSTINGERI18N1122 (measured on the develop image): in the container supervisor starts channels.sh at boot, so the
    // main agent runs from the first second, logged out, and refusing a running agent failed the wizard's switch on
    // every Docker install. A running session whose channel is not paired yet cannot act on anyone's message (the
    // claude-auth step's rule: fresh setup state, a bounce loses nothing), so for it the switch writes, reads back, then
    // restarts it. A stop before the switch does not work: supervisor and the keep-alive bring the session back in ~5 s,
    // before the renders end. Any other running agent (a paired channel, e.g. a router install whose Claude check
    // never passes) keeps the refusal, and is never restarted by this switch.
    const running = agentsRunning()
    const setupSession = running && !paired()
    if (running && !setupSession) {
      json(res, { error: 'The main agent is already running, so its files are in use: the install language can only be switched before it starts.', reason: 'agent_running' }, 409)
      return true
    }
    if (langSwitchBusy) { json(res, { error: 'A language switch is already running.', reason: 'busy' }, 409); return true }
    langSwitchBusy = true
    try {
      // The n2 re-check (an agent that starts during the switch) is skipped ONLY for the unpaired setup session, which
      // runs already and is restarted below; said in the log.
      if (setupSession) logger.info('onboarding: language switch over the running, unpaired setup session: the n2 re-check is skipped, the session is restarted after the switch')
      const result = await switchInstallLanguage(lang, {
        root: PROJECT_ROOT,
        dockerDir: process.env.MARVEEN_DOCKER_DIR || '/opt/marveen-docker',
        home: homedir(),
        readEnv: readEnvValue,
        setEnv: setEnvKey,
        readFile: (p) => { try { return readFileSync(p, 'utf-8') } catch { return null } },
        writeFile: (p, text) => atomicWriteFileSync(p, text),
        exists: (p) => existsSync(p),
        run: runNoShell,
        agentRunning: setupSession ? () => false : agentsRunning,
      })
      logger.info({ lang, ok: result.ok, files: result.files.length }, 'onboarding: install language switched')
      if (!result.ok && result.error === 'agent_running') {
        json(res, { error: 'The main agent started while the language was being switched: nothing was changed. The install language can only be switched before it starts.', reason: 'agent_running' }, 409)
      } else if (!result.ok && setupSession) {
        langRestartOwed = true
        json(res, result, 500)
      } else if (result.ok && setupSession && (result.lang !== result.previous || langRestartOwed)) {
        // Read back what the agent loads its language from before the restart.
        let langFile: string | null = null
        try { langFile = readFileSync(join(PROJECT_ROOT, '.lang'), 'utf-8').trim() } catch { /* checked below */ }
        if (langFile !== lang || readEnvValue('AGENT_TEXT_LANG') !== lang) {
          langRestartOwed = true
          logger.error({ lang, langFile }, 'onboarding: the switched language did not read back; the session is not restarted')
          json(res, { ...result, ok: false, restarted: false, error: 'The install language did not read back after the switch, so the main agent was not restarted.', reason: 'readback-failed' }, 500)
        } else if (paired()) {
          // Dani 82930: the channel was paired during the switch (it takes seconds), so the session may act on messages
          // now: not restarted. The files are switched; the restart stays owed.
          langRestartOwed = true
          logger.warn('onboarding: the channel was paired during the language switch; the main agent is not restarted')
          json(res, { ...result, ok: false, restarted: false, error: 'The install language was switched, but the channel was paired meanwhile, so the main agent was not restarted. Restart it to load the new language.', reason: 'paired_during_switch' }, 409)
        } else {
          const r = hardRestartMarveenChannels()
          if (r.ok) {
            langRestartOwed = false
            logger.info('onboarding: channels restarted so the main agent loads the switched language')
            json(res, { ...result, restarted: true })
          } else {
            langRestartOwed = true
            logger.error({ error: r.error }, 'onboarding: channels restart after the language switch FAILED')
            json(res, { ...result, ok: false, restarted: false, error: `The install language was switched, but the main agent could not be restarted (${r.error || 'restart failed'}). Restart it with: ${channelsRestartCommand()}`, reason: 'restart-failed', restartCommand: channelsRestartCommand() }, 500)
          }
        }
      } else {
        json(res, result, result.ok ? 200 : 500)
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'onboarding: the install language switch failed')
      json(res, { error: 'The install language could not be switched.', reason: 'write-failed' }, 500)
    } finally {
      langSwitchBusy = false
    }
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
    // OWNERGATE3-1104: writes OWNER_NAME / BOT_NAME / BRAND_NAME into .env and renames the owner and the agent inside
    // the main agent's CLAUDE.md and SOUL.md (who the agent believes its owner is), and may restart the channels
    // session; owner-only, before the body is read. The first-run wizard runs before the first dashboard login
    // exists, and there the bare token still passes (the first-run setup, OWNERGATE4-1104, FIRST_RUN_PATHS
    // 'onboarding-identity'), as for claude-auth below.
    if (!mayActAsOwnerOrFirstRun(ctx.auth, req, 'onboarding-identity')) {
      json(res, { ...OWNER_SESSION_REQUIRED, error: 'Changing the owner and agent names needs the dashboard login (an owner session).' }, 403)
      return true
    }
    let body: { agentName?: string; ownerName?: string } = {}
    const raw = await readBodyOrRefuse(req, res)
    if (!raw) return true
    try { body = JSON.parse(raw.toString()) as typeof body } catch { /* empty */ }
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
    const freshSetup = !(await claudeAuthPresent()) || !channelConfigured() || !paired()
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
      ...(restartError ? { restartError, restartCommand: channelsRestartCommand() } : {}),
      ...(restartNeeded ? { restartNeeded } : {}),
    })
    return true
  }

  // Store a Claude setup-token (OAuth) or API key. The value is NEVER logged or
  // echoed back -- only { ok, verified }. Zero owner/access-config clobber.
  if (path === '/api/onboarding/claude-auth' && method === 'POST') {
    // It replaces the credential the whole fleet runs on, so the shared
    // dashboard token alone is not enough once a dashboard login exists
    // (the first-run wizard runs before that, and is unaffected: OWNERGATE4-1104, FIRST_RUN_PATHS
    // 'onboarding-claude-auth').
    // OWNERGATE4-1104 (review, Samu 69637): the first-run pass only while no Claude credential is stored yet
    // (noClaudeCredentialYet: none of the places claudeAuthPresent reads, and none of them unreadable). Once one
    // exists, replacing it is the owner gate: the bare shared token cannot swap the credential the fleet runs on.
    const firstCredential = await noClaudeCredentialYet()
    if (!(firstCredential ? mayActAsOwnerOrFirstRun(ctx.auth, req, 'onboarding-claude-auth') : mayActAsOwner(ctx.auth, req))) {
      refuseOwner(res, OWNER_SESSION_REQUIRED.error)
      return true
    }
    let body: { token?: string; apiKey?: string; routerKey?: string; routerModel?: string } = {}
    const raw = await readBodyOrRefuse(req, res)
    if (!raw) return true
    try { body = JSON.parse(raw.toString()) as typeof body } catch { /* empty */ }

    // HOSTINGERROUTER1122 (Samu 83036): the Hostinger AI Router, this step's second choice, offered on a Hostinger
    // install only and never preselected. Same gate as the subscription token above; the same rules and the same write
    // as the main agent card's switch (hostinger-router.ts). No live probe: every router call is billed in the owner's
    // credits, so the key is stored unverified and the next launch tells.
    if (body.routerKey !== undefined) {
      if (body.token || body.apiKey) { json(res, { error: 'Either the Claude token or the Hostinger AI Router key, not both.', reason: 'mixed' }, 400); return true }
      if (!routerAvailable(PROJECT_ROOT)) { json(res, { error: 'The Hostinger AI Router is offered only on a Hostinger install.', reason: 'router-unavailable' }, 409); return true }
      const routerKey = String(body.routerKey ?? '').trim()
      const bad = checkRouterKey(routerKey)
      if (bad) { json(res, { error: bad, reason: 'bad-key' }, 400); return true }
      const model = resolveRouterModel(body.routerModel)
      if (!model) { json(res, { error: 'Unknown Hostinger AI Router model.', reason: 'bad-model' }, 400); return true }
      const hadAuthBeforeRouter = await claudeAuthPresent()
      try {
        applyMainRouter(MAIN_AGENT_ID, routerKey, model)
        // an "api" left next to a custom provider is a launch conflict (main-auth.ts)
        writeAgentAuthMode(MAIN_AGENT_ID, 'shared')
        // as the main agent card's router switch does (agents.ts): an API key stored earlier leaves the vault
        // (HOSTINGERROUTERFU1122, Geri N1)
        deleteSecret(`agent-${MAIN_AGENT_ID}-api-key`)
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'onboarding: failed to save the Hostinger AI Router')
        json(res, { error: 'Could not save the Hostinger AI Router setting.', reason: 'write-failed' }, 500)
        return true
      }
      // The same restart rule as below: only when the install had no auth, so the running session is a fresh setup one.
      let routerRestarted = false
      let routerRestartError: string | null = null
      if (!hadAuthBeforeRouter && agentsRunning()) {
        const r = hardRestartMarveenChannels()
        routerRestarted = r.ok
        if (!r.ok) routerRestartError = r.error || 'restart failed'
      }
      logger.info({ model, restarted: routerRestarted }, 'onboarding: Hostinger AI Router stored for the main agent')
      json(res, routerRestartError
        ? { ok: true, router: true, model, verified: false, restarted: false, restartError: routerRestartError, restartCommand: channelsRestartCommand() }
        : { ok: true, router: true, model, verified: false, restarted: routerRestarted })
      return true
    }
    const token = (body.token ?? '').trim()
    const apiKey = (body.apiKey ?? '').trim()
    if (!token && !apiKey) { json(res, { error: 'token vagy apiKey szukseges.', reason: 'missing' }, 400); return true }
    if (token && !/^sk-ant-oat/.test(token)) { json(res, { error: 'A setup-token formatuma nem stimmel (sk-ant-oat...).', reason: 'bad-token' }, 400); return true }
    if (apiKey && !/^sk-ant-/.test(apiKey)) { json(res, { error: 'Az API-kulcs formatuma nem stimmel (sk-ant-...).', reason: 'bad-key' }, 400); return true }
    // One line only: .env is line-based (ENVINJECT1028). Refused before the live probe and any write.
    if (/[\r\n\0]/.test(token + apiKey)) { json(res, { error: 'A token/kulcs nem tartalmazhat sortorest.', reason: token ? 'bad-token' : 'bad-key' }, 400); return true }

    // Read BEFORE persisting: on a fresh install the channels session is
    // booted by the installer/service unit with NO credentials, so if the
    // install had no auth at this point, a running session is unauthenticated
    // by construction. That is the one case where this endpoint must restart
    // it after the save -- a running process never picks up new env.
    const hadAuthBefore = await claudeAuthPresent()

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
      json(res, { error: 'A megadott token/kulcs nem érvényes (a próba-hívást a szerver elutasította). Ellenőrizd, hogy a teljes setup-tokent illesztetted-e be.', reason: 'verify-failed', verified: false }, 400)
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
    json(res, restartError ? { ok: true, verified, restarted, restartError, restartCommand: channelsRestartCommand() } : { ok: true, verified, restarted })
    return true
  }

  // Launch the fleet (main-agent channels session). Idempotent: no double-spawn.
  if (path === '/api/onboarding/launch' && method === 'POST') {
    if (agentsRunning()) { json(res, { ok: true, alreadyRunning: true }); return true }
    if (!(await claudeAuthPresent())) { json(res, { error: 'Eloszor allitsd be a Claude-autentikaciot.', reason: 'no-auth' }, 409); return true }
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
