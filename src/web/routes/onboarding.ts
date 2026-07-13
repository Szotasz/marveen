import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { resolveFromPath } from '../../platform.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { channelStateDir } from '../../channel-provider.js'
import { sessionExistsOnHost } from '../agent-process.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
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

// True auth presence -- an env OAuth token / API key, OR a real credentials.json
// OAuth credential. NOT merely "the .env line exists" (it could be empty).
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
  return false
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

export async function tryHandleOnboarding(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Onboarding state so the frontend knows which step to show.
  if (path === '/api/onboarding/status' && method === 'GET') {
    const claude = claudeAuthPresent()
    const running = agentsRunning()
    const tg = telegramConfigured()
    const pr = paired()
    json(res, {
      claudeAuthPresent: claude,
      agentsRunning: running,
      telegramConfigured: tg,
      paired: pr,
      needsOnboarding: !claude || !running || !tg || !pr,
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

    try {
      if (token) {
        setEnvKey('CLAUDE_CODE_OAUTH_TOKEN', token)
        // Keep the credentials-guard fleet token file in sync (harmless if unused).
        try { mkdirSync(STORE_DIR, { recursive: true }); writeFileSync(FLEET_TOKEN_FILE, token, { mode: 0o600 }) } catch { /* optional */ }
      } else {
        setEnvKey('ANTHROPIC_API_KEY', apiKey)
      }
    } catch (err) {
      logger.error({ err }, 'onboarding: failed to persist Claude auth to .env')
      json(res, { error: 'Nem sikerult elmenteni az .env-be.', reason: 'write-failed' }, 500)
      return true
    }

    // Verify WITHOUT an API spend: `claude auth status` only inspects the token.
    let verified = false
    try {
      execFileSync(resolveFromPath('claude'), ['auth', 'status'], {
        timeout: 25_000,
        stdio: 'ignore',
        env: { ...process.env, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : { ANTHROPIC_API_KEY: apiKey }) },
      })
      verified = true
    } catch { verified = false }
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
