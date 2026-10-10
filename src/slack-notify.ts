/**
 * Slack delivery for owner notifications (SLACKATALLAS1006).
 *
 * The owner moved the fleet's notifications to Slack, onto topic channels.
 * Every Telegram owner/alert send in the dashboard already funnels through
 * src/notify.ts; this module is the Slack side of that funnel, and the CLI
 * (scripts/slack-notify.mjs) uses the same functions so an agent, a scheduled
 * task or scripts/notify.sh posts the same way.
 *
 * Nothing install-specific lives in code:
 *   - channel NAMES resolve through store/slack-channels.json
 *     ({"napindito": "C0...", ...}); a raw C/G/D id is used as given;
 *   - "dm" opens the owner's DM from the owner's USER id (conversations.open):
 *     a D-id is per bot pair, so a fixed one only works for one sender;
 *   - the owner user id is SLACK_OWNER_USER_ID, else the single allowFrom
 *     entry of the main agent's Slack access.json (never a guess between two).
 *
 * Sender: an agent posts with ITS OWN bot token (agents/<name>/.claude/
 * channels/slack/.env). When it has none, or Slack answers not_in_channel /
 * channel_not_found, the message goes out with the MAIN agent's token and the
 * sender's name in front ("[boni] ..."), the way notify.sh attributes today.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from './config.js'
import { formatForSlackMrkdwn } from './channel-provider.js'

/** Lazy: a module-load join would break every importer whose test mocks config.js partially. */
export function slackChannelMapPath(): string { return join(STORE_DIR, 'slack-channels.json') }
const SLACK_ID_RX = /^[CGD][A-Z0-9]{6,}$/
const USER_ID_RX = /^[UW][A-Z0-9]{6,}$/
/** Slack accepts ~40k chars, but long posts are cut in the client; stay well under. */
export const SLACK_CHUNK = 3500

export type SlackTarget = { kind: 'channel'; id: string } | { kind: 'dm'; userId: string }

export interface SlackDeps {
  fetch: typeof fetch
  readFile: (p: string) => string | null
}

const defaultDeps: SlackDeps = {
  fetch: (...a) => fetch(...a),
  readFile: (p) => { try { return existsSync(p) ? readFileSync(p, 'utf-8') : null } catch { return null } },
}

// ---------------------------------------------------------------------------
// Pure resolution
// ---------------------------------------------------------------------------

/** "dm" | a channel name from the map | a raw C/G/D id. null = cannot resolve (never a guess). */
export function resolveSlackTarget(
  raw: string,
  channelMap: Record<string, string>,
  ownerUserId: string | null,
): SlackTarget | null {
  const t = raw.trim().replace(/^#/, '')
  if (!t) return null
  if (t.toLowerCase() === 'dm') return ownerUserId ? { kind: 'dm', userId: ownerUserId } : null
  if (SLACK_ID_RX.test(t)) return { kind: 'channel', id: t }
  const mapped = channelMap[t] ?? channelMap[t.toLowerCase()]
  return mapped && SLACK_ID_RX.test(mapped) ? { kind: 'channel', id: mapped } : null
}

export function parseChannelMap(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
      if (typeof id === 'string' && SLACK_ID_RX.test(id)) out[k] = id
    }
    return out
  } catch {
    return {}
  }
}

/** The owner's Slack user id: explicit setting first, else exactly one allowFrom entry. */
export function resolveOwnerUserId(explicit: string | undefined, accessJson: string | null): string | null {
  const e = (explicit ?? '').trim()
  if (USER_ID_RX.test(e)) return e
  if (!accessJson) return null
  try {
    const a = JSON.parse(accessJson) as { allowFrom?: unknown }
    const list = Array.isArray(a.allowFrom) ? a.allowFrom.filter((x): x is string => typeof x === 'string' && USER_ID_RX.test(x)) : []
    return list.length === 1 ? list[0] : null
  } catch {
    return null
  }
}

export function splitForSlack(text: string, size = SLACK_CHUNK): string[] {
  if (text.length <= size) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------------------------------------------------------------------------
// Paths (main agent's state dir resolved WITHOUT the env override: inside an
// agent session SLACK_STATE_DIR names that agent's dir, not the main one)
// ---------------------------------------------------------------------------

export function mainSlackStateDir(read: (p: string) => string | null = defaultDeps.readFile): string {
  const installScoped = join(PROJECT_ROOT, '.claude', 'channels', 'slack')
  const legacy = join(homedir(), '.claude', 'channels', 'slack')
  const has = (d: string) => read(join(d, '.env')) !== null
  return has(legacy) && !has(installScoped) ? legacy : installScoped
}

export function agentSlackStateDir(agent: string): string {
  return join(PROJECT_ROOT, 'agents', agent, '.claude', 'channels', 'slack')
}

function tokenFrom(dir: string, deps: SlackDeps): string | null {
  const raw = deps.readFile(join(dir, '.env'))
  if (!raw) return null
  const m = raw.match(/^SLACK_BOT_TOKEN=(.+)$/m)
  const tok = m ? m[1].trim() : ''
  return tok.startsWith('xoxb-') ? tok : null
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean
  channel?: string
  /** 'own' = the sender's bot; 'main' = fell back to the main agent's bot. */
  via?: 'own' | 'main'
  error?: string
}

async function api(deps: SlackDeps, token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; channel?: { id?: string } }> {
  const resp = await deps.fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) return { ok: false, error: `http_${resp.status}` }
  return (await resp.json()) as { ok: boolean; error?: string; channel?: { id?: string } }
}

async function postWith(deps: SlackDeps, token: string, target: SlackTarget, text: string): Promise<SendResult> {
  let channel: string
  if (target.kind === 'dm') {
    const opened = await api(deps, token, 'conversations.open', { users: target.userId })
    if (!opened.ok || !opened.channel?.id) return { ok: false, error: opened.error ?? 'dm_open_failed' }
    channel = opened.channel.id
  } else {
    channel = target.id
  }
  for (const chunk of splitForSlack(formatForSlackMrkdwn(text))) {
    const r = await api(deps, token, 'chat.postMessage', { channel, text: chunk, unfurl_links: false, unfurl_media: false })
    if (!r.ok) return { ok: false, channel, error: r.error ?? 'post_failed' }
  }
  return { ok: true, channel }
}

const FALLBACK_ERRORS = new Set(['not_in_channel', 'channel_not_found', 'dm_open_failed', 'cannot_dm_bot', 'user_not_found'])

/**
 * Post `text` to `rawTarget` as `sender` (an agent name, or the main agent when
 * omitted). Never throws: a delivery failure comes back as { ok: false }.
 */
export async function sendSlackNotification(
  rawTarget: string,
  text: string,
  opts: { sender?: string; ownerUserId?: string; deps?: Partial<SlackDeps> } = {},
): Promise<SendResult> {
  const deps: SlackDeps = { ...defaultDeps, ...opts.deps }
  try {
    const mainDir = mainSlackStateDir(deps.readFile)
    const owner = resolveOwnerUserId(opts.ownerUserId, deps.readFile(join(mainDir, 'access.json')))
    const target = resolveSlackTarget(rawTarget, parseChannelMap(deps.readFile(slackChannelMapPath())), owner)
    if (!target) return { ok: false, error: `unresolved_target:${rawTarget}` }
    const sender = opts.sender && opts.sender !== MAIN_AGENT_ID ? opts.sender : null
    const mainToken = tokenFrom(mainDir, deps)
    const ownToken = sender ? tokenFrom(agentSlackStateDir(sender), deps) : mainToken
    if (ownToken) {
      const r = await postWith(deps, ownToken, target, text)
      if (r.ok) return { ...r, via: sender ? 'own' : 'main' }
      if (!sender || !FALLBACK_ERRORS.has(r.error ?? '')) return r
    }
    if (!mainToken) return { ok: false, error: 'no_slack_token' }
    const r = await postWith(deps, mainToken, target, sender ? `[${sender}] ${text}` : text)
    return r.ok ? { ...r, via: 'main' } : r
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

