import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { resolveFromPath } from '../../platform.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { channelStateDir } from '../../channel-provider.js'
import { sessionExistsOnHost } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { liveProbeAuth, stampTokenVerified } from '../claude-credentials-guard.js'
import { json, readBody } from '../http-helpers.js'
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
  return keychainHasClaudeCredentials()
}

function telegramConfigured(): boolean {
  try {
    return /^TELEGRAM_BOT_TOKEN=\S/m.test(readFileSync(join(channelStateDir('telegram'), '.env'), 'utf-8'))
  } catch { return false }
}

function paired(): boolean {
  try {
    const a = JSON.parse(readFileSync(join(channelStateDir('telegram'), 'access.json'), 'utf-8')) as {
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

export async function tryHandleOnboarding(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Onboarding state so the frontend knows which step to show.
  if (path === '/api/onboarding/status' && method === 'GET') {
    const claude = claudeAuthPresent()
    const running = agentsRunning()
    const tg = telegramConfigured()
    const pr = paired()
    json(res, {
      identityConfirmed: identityConfirmed(),
      currentAgentName: readEnvValue('BRAND_NAME') || readEnvValue('BOT_NAME') || 'Marveen',
      currentOwnerName: readEnvValue('OWNER_NAME') || '',
      claudeAuthPresent: claude,
      agentsRunning: running,
      telegramConfigured: tg,
      paired: pr,
      // The identity step never re-opens the wizard on an already-configured
      // install: it only participates while first-run setup is incomplete.
      needsOnboarding: !claude || !running || !tg || !pr,
    })
    return true
  }

  // Identity step: agent display name + owner name. SAFETY: MAIN_AGENT_ID and
  // SERVICE_ID are baked into the plumbing at install time (tmux session name,
  // DB rows, OS service-unit names) -- rewriting them after the services exist
  // orphans running units and can lock the owner out. The display name and the
  // internal id may freely differ, so:
  //   - services not yet launched: BOT_NAME + BRAND_NAME + OWNER_NAME may all
  //     be set (launch picks them up from .env); the id plumbing stays as the
  //     installer derived it.
  //   - services already running: only BRAND_NAME + OWNER_NAME + the persona
  //     files change. BOT_NAME is left alone with the rest of the plumbing.
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
    const prevAgentName = readEnvValue('BOT_NAME') || 'Marveen'
    const prevOwnerName = readEnvValue('OWNER_NAME') || ''
    try {
      setEnvKey('OWNER_NAME', ownerName)
      setEnvKey('BRAND_NAME', agentName)
      if (!servicesUp) setEnvKey('BOT_NAME', agentName)
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

    logger.info({ servicesUp, botNameUpdated: !servicesUp }, 'onboarding: identity configured')
    json(res, { ok: true, botNameUpdated: !servicesUp })
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
    logger.info({ verified, mode: token ? 'oauth' : 'apikey' }, 'onboarding: Claude auth stored')
    json(res, { ok: true, verified })
    return true
  }

  // Launch the fleet (main-agent channels session). Idempotent: no double-spawn.
  if (path === '/api/onboarding/launch' && method === 'POST') {
    if (agentsRunning()) { json(res, { ok: true, alreadyRunning: true }); return true }
    if (!claudeAuthPresent()) { json(res, { error: 'Eloszor allitsd be a Claude-autentikaciot.', reason: 'no-auth' }, 409); return true }
    const r = hardRestartMarveenChannels()
    if (!r.ok) { json(res, { error: r.error || 'Nem sikerult eletre kelteni az agenteket.', reason: 'launch-failed' }, 500); return true }
    logger.info('onboarding: fleet launched (channels session)')
    json(res, { ok: true, started: true })
    return true
  }

  return false
}
