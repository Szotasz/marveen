import https from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import { formatForTelegram, splitMessage } from './format.js'
import { markIfTestRun } from './test-run-marker.js'
import { TOOL_TIMEOUTS } from './tool-timeouts.js'
import { sendTeamsMessage, type TeamsCreds } from './teams-send.js'

export type ChannelProviderType = 'telegram' | 'slack' | 'discord' | 'googlechat' | 'teams'

/**
 * What a successful send can tell about itself: the HTTP status of the answer
 * and the id the service gave the new message, when it gives one. Never the
 * chat or the text -- the channel log (notify.ts) records exactly this.
 */
export interface SendReceipt {
  status: number
  messageId?: string
}

export interface ChannelProvider {
  readonly type: ChannelProviderType
  readonly pluginId: string
  readonly pluginPaneId: string
  /** The MCP server name the installed plugin registers, as `/mcp reconnect <name>` takes it. Omitted when it is
   *  the same as pluginPaneId. */
  readonly mcpServerName?: string
  readonly envKeys: string[]
  readonly stateDir: string
  readonly chatIdFormat: string
  /** threadId: a Telegram topic (TELEGRAM_TOPICS_ENABLED); providers without topics ignore it. */
  sendMessage(token: string, chatId: string, text: string, parseMode?: string, threadId?: string): Promise<SendReceipt | void>
  sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  validateToken(token: string): Promise<TokenValidation>
  /** For providers whose credentials are more than one token (Teams): check them all for real. */
  validateCredentials?(env: Record<string, string>): Promise<TokenValidation>
  formatMessage(text: string): string
  splitMessage(text: string): string[]
}

/** What validateToken reports. `scopes` and `missingScopes` are filled only by
 *  a provider that can read the token's granted scopes (Slack); absent means
 *  "not known", never "none missing". */
export interface TokenValidation {
  ok: boolean
  botName?: string
  error?: string
  scopes?: string[]
  missingScopes?: string[]
}

// -- Telegram implementation --

// Every sendMessage below carries a deadline. The scheduler's pending-retry
// alert stamps `alert_sent_at` BEFORE the send and clears it only on a thrown
// error, so a socket that never answers would pin the stamp forever and
// silence that alert for good. A timeout turns the hang into an error the
// callers already classify as transient (no HTTP status) and retry next tick.
// Resolves with the Bot API's `result` (undefined when the body is not JSON).
function telegramHttpPostResult(token: string, method: string, body: string, contentType: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: TOOL_TIMEOUTS['telegram'],
      },
      (res) => {
        // Read the body even on HTTP 200: the Bot API can answer 200 with
        // {"ok":false,...}, and discarding the body turned that into a silent
        // success -- the same blind spot the bash senders closed in
        // NOTIFYVAKSWEEP826 (success = transport OK AND "ok":true). TSOKFALSE827.
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8')
          let result: unknown
          if (res.statusCode !== 200) {
            reject(new Error(`Telegram API ${res.statusCode}: ${responseBody.slice(0, 200)}`))
            return
          }
          try {
            const parsed = JSON.parse(responseBody) as { ok?: boolean; error_code?: number; description?: string; result?: unknown }
            if (parsed.ok === false) {
              // Carry the body's error_code in the "Telegram API <code>" shape so
              // classifySendError sorts it transient/permanent like an HTTP status;
              // without a code the message stays status-free -> transient (retry).
              const code = typeof parsed.error_code === 'number' ? ` ${parsed.error_code}` : ''
              reject(new Error(`Telegram API${code}: ok:false ${String(parsed.description ?? '').slice(0, 200)}`))
              return
            }
            result = parsed.result
          } catch {
            // A malformed body on HTTP 200 is not a send failure; the message
            // may well be delivered. Same tolerance as sendTelegramMessage.
          }
          resolve(result)
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    // The `timeout` option only emits the event; the request must be destroyed by hand, which surfaces through the 'error' handler above.
    req.on('timeout', () => req.destroy(new Error(`Telegram ${method} timed out after ${TOOL_TIMEOUTS['telegram']}ms`)))
    req.write(body)
    req.end()
  })
}

// sendMessage's receipt: the message id when the Bot API returned a numeric one.
async function telegramHttpPost(token: string, method: string, body: string, contentType: string): Promise<SendReceipt> {
  const result = await telegramHttpPostResult(token, method, body, contentType)
  const messageId = (result as { message_id?: unknown } | undefined)?.message_id
  return { status: 200, messageId: typeof messageId === 'number' ? String(messageId) : undefined }
}

/** Opens a topic in a chat (a private chat needs topics switched on in BotFather); returns its message_thread_id. */
export async function createTelegramForumTopic(token: string, chatId: string, name: string): Promise<number> {
  const result = await telegramHttpPostResult(token, 'createForumTopic', JSON.stringify({ chat_id: chatId, name }), 'application/json')
  const threadId = (result as { message_thread_id?: unknown } | undefined)?.message_thread_id
  if (typeof threadId !== 'number' || !Number.isInteger(threadId) || threadId <= 0) {
    throw new Error('Telegram API: createForumTopic returned no message_thread_id')
  }
  return threadId
}

const telegramProvider: ChannelProvider = {
  type: 'telegram',
  pluginId: 'telegram@claude-plugins-official',
  pluginPaneId: 'plugin:telegram:telegram',
  envKeys: ['TELEGRAM_BOT_TOKEN'],
  stateDir: 'telegram',
  chatIdFormat: 'numeric (e.g. 1268077055)',

  async sendMessage(token, chatId, text, parseMode, threadId) {
    const payload: Record<string, string | number> = { chat_id: chatId, text }
    if (parseMode) payload.parse_mode = parseMode
    if (threadId) payload.message_thread_id = Number(threadId)
    const body = JSON.stringify(payload)
    return telegramHttpPost(token, 'sendMessage', body, 'application/json')
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath)
    const boundary = '----FormBoundary' + Date.now()
    const parts: Buffer[] = []
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Telegram sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  },

  async validateToken(token) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
      const data = await resp.json() as { ok: boolean; result?: { username: string; id: number } }
      if (data.ok && data.result) {
        return { ok: true, botName: data.result.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Telegram API' }
    }
  },

  formatMessage: formatForTelegram,
  splitMessage: (text) => splitMessage(text),
}

// MCPTOKEN807: a syntactically valid token (getMe ok) can still be UNUSABLE by
// our poller. Two live-measured cases (Szabolcs, 2026-08-07 fresh install with
// a reused test-bot token): a webhook bound to the bot, or another running
// install already long-polling getUpdates -- either way the plugin dies with an
// opaque "-32000" at runtime. Probe BOTH at save time and answer in human
// language with the remedy. The probe is advisory: if the probe request itself
// fails (network hiccup -- getMe already proved connectivity moments ago), we
// let the save through rather than block setup on a transient error.
// NOT part of validateToken: the /test endpoint validates the agent's CURRENT
// token, whose own running poller would 409 against this probe (false busy).
// Call it only when saving a token that differs from the one already stored.
export async function checkTelegramTokenBusy(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ busy: boolean; reason?: 'webhook' | 'poller'; error?: string }> {
  try {
    const wh = await fetchImpl(`https://api.telegram.org/bot${token}/getWebhookInfo`)
    const whData = await wh.json() as { ok: boolean; result?: { url?: string } }
    if (whData.ok && whData.result?.url) {
      return {
        busy: true,
        reason: 'webhook',
        // The token itself must never appear in this user-facing message.
        error: 'A bot token érvényes, de a bot jelenleg webhookra van kötve, így a Marveen nem tud rá csatlakozni. '
          + `Teendő: szüntesd meg a webhookot (nyisd meg böngészőben: https://api.telegram.org/bot<A-TOKENED>/deleteWebhook), `
          + 'vagy készíts új botot a @BotFather-nél, és annak a tokenjét add meg itt.',
      }
    }
    const up = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&limit=1`)
    if (up.status === 409) {
      return {
        busy: true,
        reason: 'poller',
        error: 'A bot token érvényes, de egy másik futó rendszer már használja (a Telegram 409 Conflict választ adott). '
          + 'Egy bot tokent egyszerre csak egy telepítés használhat. Teendő: állítsd le a korábbi telepítést, '
          + 'amelyik még ezzel a tokennel fut, vagy készíts új botot a @BotFather-nél, és annak a tokenjét add meg itt.',
      }
    }
    return { busy: false }
  } catch {
    return { busy: false }
  }
}

// -- Slack implementation (stub) --
// The actual Slack channel plugin (jeremylongshore/claude-code-slack-channel)
// handles message delivery via its own MCP tools. This stub provides the
// notification path (direct API calls for alerts/heartbeats outside the
// plugin's scope) and token validation.

const SLACK_MAX_MESSAGE_LENGTH = 4000

export function formatForSlackMrkdwn(text: string): string {
  // Slack uses mrkdwn, not HTML. The subset that matters:
  // bold: *text*, italic: _text_, strikethrough: ~text~,
  // code: `code`, code block: ```code```, link: <url|text>
  let result = text

  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')
  result = result.replace(/__(.+?)__/g, '*$1*')
  result = result.replace(/~~(.+?)~~/g, '~$1~')
  result = result.replace(/\[(.+?)\]\((.+?)\)/g, '<$2|$1>')
  result = result.replace(/^- \[ \]/gm, ':white_square: ')
  result = result.replace(/^- \[x\]/gm, ':white_check_mark: ')

  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  return result.trim()
}

const slackProvider: ChannelProvider = {
  type: 'slack',
  pluginId: 'slack-channel@marveen-marketplace',
  pluginPaneId: 'plugin:slack-channel:marveen-marketplace',
  mcpServerName: 'plugin:slack-channel:slack',
  envKeys: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  stateDir: 'slack',
  chatIdFormat: 'Slack channel/DM ID (e.g. C01234ABCDE)',

  async sendMessage(token, chatId, text) {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: chatId,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['slack']),
    })
    if (!resp.ok) {
      throw new Error(`Slack API HTTP ${resp.status}`)
    }
    const data = await resp.json() as { ok: boolean; error?: string }
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`)
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    // Slack file upload v2: get upload URL, upload file, complete
    const fileData = readFileSync(photoPath)
    const filename = photoPath.split('/').pop() || 'image.png'

    const urlResp = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: `filename=${encodeURIComponent(filename)}&length=${fileData.length}`,
    })
    const urlData = await urlResp.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(`Slack getUploadURL: ${urlData.error || 'unknown error'}`)
    }

    await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileData,
    })

    const completeResp = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: caption || filename }],
        channel_id: chatId,
        initial_comment: caption || undefined,
      }),
    })
    const completeData = await completeResp.json() as { ok: boolean; error?: string }
    if (!completeData.ok) {
      throw new Error(`Slack completeUpload: ${completeData.error}`)
    }
  },

  async validateToken(token) {
    try {
      const resp = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${token}`,
        },
      })
      const data = await resp.json() as { ok: boolean; bot_id?: string; user?: string; error?: string }
      if (data.ok) {
        // SLACKSCOPEJELZ1007: the granted bot scopes come back in the
        // x-oauth-scopes header only. Reported against the manifest's list so
        // a missing scope (im:read: the slack-channel plugin needs it to write
        // to an allowFrom user's DM after a restart, SLACKOUTDM1007) shows up
        // without anyone asking the owner. No header -> no claim.
        const granted = parseSlackScopes(resp.headers.get('x-oauth-scopes'))
        return {
          ok: true,
          botName: data.user || data.bot_id,
          ...(granted ? { scopes: granted, missingScopes: missingSlackScopes(granted) } : {}),
        }
      }
      return { ok: false, error: data.error || 'Invalid token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Slack API' }
    }
  },

  formatMessage: formatForSlackMrkdwn,
  splitMessage: (text) => splitMessage(text, SLACK_MAX_MESSAGE_LENGTH),
}

// -- Discord implementation --

const DISCORD_MAX_MESSAGE_LENGTH = 2000

function formatForDiscord(text: string): string {
  // Discord natively renders GFM markdown (bold, italic, code blocks, links).
  // Only convert task-list checkboxes which Discord does not support.
  let result = text
  result = result.replace(/^- \[ \]/gm, '☐')
  result = result.replace(/^- \[x\]/gm, '☑')
  return result
}

const discordProvider: ChannelProvider = {
  type: 'discord',
  pluginId: 'discord@claude-plugins-official',
  pluginPaneId: 'plugin:discord:discord',
  envKeys: ['DISCORD_BOT_TOKEN'],
  stateDir: 'discord',
  chatIdFormat: 'Discord channel ID (e.g. 1234567890123456789)',

  async sendMessage(token, chatId, text) {
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${token}`,
      },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['discord']),
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Discord API ${resp.status}: ${body.slice(0, 200)}`)
    }
  },

  async sendPhoto(token, chatId, photoPath, caption) {
    const fileData = readFileSync(photoPath)
    const filename = photoPath.split('/').pop() || 'image.png'
    const boundary = '----FormBoundary' + Date.now()
    const parts: Buffer[] = []
    const payloadJson = JSON.stringify({
      content: caption || undefined,
      attachments: [{ id: '0', filename }],
    })
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${payloadJson}\r\n`))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
    const body = Buffer.concat(parts)
    const resp = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Authorization': `Bot ${token}`,
      },
      body,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Discord sendPhoto ${resp.status}: ${text.slice(0, 200)}`)
    }
  },

  async validateToken(token) {
    try {
      const resp = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { 'Authorization': `Bot ${token}` },
      })
      const data = await resp.json() as { id?: string; username?: string }
      if (resp.ok && data.username) {
        return { ok: true, botName: data.username }
      }
      return { ok: false, error: 'Invalid bot token' }
    } catch {
      return { ok: false, error: 'Failed to connect to Discord API' }
    }
  },

  formatMessage: formatForDiscord,
  splitMessage: (text) => splitMessage(text, DISCORD_MAX_MESSAGE_LENGTH),
}

// -- Google Chat implementation --
//
// Google Chat (Workspace) has no bot token: the channel plugin authenticates
// with a service-account key and consumes events over Cloud Pub/Sub. So the
// token-based dashboard helpers below are minimal -- actual delivery happens
// through the plugin's MCP tools, not these direct-send methods. "Configured"
// is detected via GOOGLECHAT_PROJECT_ID in the agent's channel .env (see
// readChannelToken), which stands in for the token the other providers use.

const GOOGLECHAT_MAX_MESSAGE_LENGTH = 4096

const googlechatProvider: ChannelProvider = {
  type: 'googlechat',
  pluginId: 'googlechat@claude-channel-googlechat',
  pluginPaneId: 'plugin:googlechat:googlechat',
  envKeys: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLECHAT_PROJECT_ID', 'GOOGLECHAT_SUBSCRIPTION'],
  stateDir: 'googlechat',
  chatIdFormat: 'space resource name (e.g. spaces/AAAA)',

  async sendMessage() {
    // Direct dashboard send is not supported for Google Chat; the agent
    // delivers via the plugin's reply tool inside its own session.
    throw new Error('googlechat: direct dashboard send not supported (delivery via plugin MCP tools)')
  },

  async sendPhoto() {
    throw new Error('googlechat: direct dashboard send not supported (delivery via plugin MCP tools)')
  },

  async validateToken() {
    // No token model; real validation happens in the plugin (service-account
    // key + Pub/Sub). Report ok so channel-config flows don't false-negative.
    return { ok: true, botName: 'Google Chat' }
  },

  formatMessage: (text) => text,
  splitMessage: (text) => splitMessage(text, GOOGLECHAT_MAX_MESSAGE_LENGTH),
}

// -- Microsoft Teams implementation --
//
// Teams (Azure Bot Service) has no single bot token: the channel plugin
// authenticates with an app id + client secret + tenant id (TEAMS_BOT_*) and
// receives Activities over an inbound webhook (JWT-validated). The agent's own
// replies go through the plugin's MCP tools; the DASHBOARD alerts (notify.ts,
// schedule-runner.ts) send directly over the Bot Framework REST API
// (teams-send.ts), using the same three credentials from the same .env the
// plugin reads. "Configured" is detected via TEAMS_BOT_APP_ID in the agent's
// channel .env (see readChannelToken), standing in for the token.

const TEAMS_MAX_MESSAGE_LENGTH = 28000

export const TEAMS_SECRET_EXPIRY_KEY = 'TEAMS_BOT_SECRET_EXPIRES'
export const TEAMS_SECRET_WARN_DAYS = [30, 7, 1] as const
export type TeamsSecretExpiry =
  | { state: 'missing' }
  | { state: 'invalid'; value: string }
  | { state: 'ok' | 'soon' | 'expired'; date: string; daysLeft: number }

export function teamsSecretExpiry(raw: string | undefined, now: number = Date.now()): TeamsSecretExpiry {
  const value = (raw ?? '').trim()
  if (!value) return { state: 'missing' }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const expiresAt = Date.UTC(y, mo - 1, d)
    const back = new Date(expiresAt)
    if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d) {
      const daysLeft = Math.ceil((expiresAt - now) / 86_400_000) + 0
      return { state: daysLeft <= 0 ? 'expired' : daysLeft <= 30 ? 'soon' : 'ok', date: value, daysLeft }
    }
  }
  // Only a value that looks like a mistyped date is echoed into the log and the
  // Test answer; anything else (a secret pasted into the wrong key) is not.
  return { state: 'invalid', value: /^[0-9./ -]{1,20}$/.test(value) ? value : `(${value.length} characters, not shown)` }
}

export const TEAMS_CREDENTIAL_TIMEOUT_MS = 10_000

export async function checkTeamsCredentials(
  env: Record<string, string>,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<TokenValidation> {
  const appId = env.TEAMS_BOT_APP_ID
  const secret = env.TEAMS_BOT_APP_PASSWORD
  const tenant = env.TEAMS_BOT_TENANT_ID
  if (!appId || !secret || !tenant) {
    return { ok: false, error: 'Teams credentials incomplete: TEAMS_BOT_APP_ID, TEAMS_BOT_APP_PASSWORD and TEAMS_BOT_TENANT_ID are all needed' }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(tenant)) {
    return { ok: false, error: 'Teams tenant id has an unexpected form' }
  }
  let res: Response
  try {
    res = await (deps.fetch ?? fetch)(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: secret,
        scope: 'https://api.botframework.com/.default',
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? TEAMS_CREDENTIAL_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: 'Teams credentials could not be checked (network error or timeout)' }
  }
  // A refusal of these credentials is a 400/401 with Entra's JSON error body.
  // Throttling, an Entra outage or an answer that cannot be read says nothing
  // about the secret, so it is "could not be checked", not a refusal.
  let body: any
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (res.status === 200 && typeof body?.access_token === 'string' && body.access_token) {
    return { ok: true, botName: 'Microsoft Teams' }
  }
  if ((res.status !== 400 && res.status !== 401) || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: `Teams credentials could not be checked (unexpected Entra answer, HTTP ${res.status})` }
  }
  const code = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'unknown_error'
  const first = Array.isArray(body.error_codes) ? body.error_codes[0] : undefined
  const aad = typeof first === 'number' && Number.isInteger(first) ? first : undefined
  return { ok: false, error: `Teams credentials refused by Entra: ${code}${aad !== undefined ? ` (AADSTS${aad})` : ''}` }
}

const teamsProvider: ChannelProvider = {
  type: 'teams',
  pluginId: 'teams@marveen-marketplace',
  pluginPaneId: 'plugin:teams:marveen-marketplace',
  mcpServerName: 'plugin:teams:teams',
  envKeys: ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID'],
  stateDir: 'teams',
  chatIdFormat: 'Teams conversation id (managed by the plugin per pairing)',

  async sendMessage(token, chatId, text) {
    // Direct dashboard send over the Bot Framework REST API: a
    // client-credentials token plus the conversation's recorded serviceUrl
    // (teams-send.ts). The `token` parameter is the app id stand-in from
    // readChannelToken -- the real credentials come from the channel .env,
    // the same file the plugin itself runs with.
    return sendTeamsMessage(readTeamsCreds(token), channelStateDir('teams'), chatId, text)
  },

  async sendPhoto() {
    throw new Error('teams: direct dashboard send not supported (delivery via plugin MCP tools)')
  },

  async validateToken() {
    // No simple token model; real validation happens in the plugin (app id +
    // secret + tenant, JWT). Report ok so channel-config flows don't false-negative.
    return { ok: true, botName: 'Microsoft Teams' }
  },

  validateCredentials: (env) => checkTeamsCredentials(env),

  formatMessage: (text) => text,
  splitMessage: (text) => splitMessage(text, TEAMS_MAX_MESSAGE_LENGTH),
}

// -- Slack App manifest --

const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'reactions:write',
  'users:read',
]

/** The `x-oauth-scopes` header as a list; null when the header is absent OR
 *  empty: an empty header is "not known", not "no scope granted" (an
 *  auth.test that succeeded always has at least one scope). */
export function parseSlackScopes(header: string | null | undefined): string[] | null {
  if (header == null || header.trim() === '') return null
  return header.split(',').map(s => s.trim()).filter(Boolean)
}

/** The manifest's bot scopes the token was not granted, in manifest order. */
export function missingSlackScopes(granted: readonly string[]): string[] {
  const have = new Set(granted)
  return SLACK_BOT_SCOPES.filter(s => !have.has(s))
}

const SLACK_BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
]

export function generateSlackAppManifest(appName: string): string {
  const safeName = appName.replace(/["\\]/g, '')
  const scopes = SLACK_BOT_SCOPES.map(s => `        - ${s}`).join('\n')
  const events = SLACK_BOT_EVENTS.map(e => `        - ${e}`).join('\n')
  return [
    'display_information:',
    `  name: ${JSON.stringify(safeName)}`,
    'features:',
    '  bot_user:',
    `    display_name: ${JSON.stringify(safeName)}`,
    '    always_online: true',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    scopes,
    'settings:',
    '  event_subscriptions:',
    '    bot_events:',
    events,
    '  interactivity:',
    '    is_enabled: true',
    '  org_deploy_enabled: false',
    '  socket_mode_enabled: true',
    '  token_rotation_enabled: false',
  ].join('\n')
}

export function getSlackAppSetupInstructions(): string[] {
  return [
    'Nyisd meg az api.slack.com/apps oldalt',
    'Kattints a "Create New App" gombra, majd válaszd a "From an app manifest" lehetőséget',
    'Válaszd ki a workspace-t ahova telepíteni szeretnéd',
    'Válts YAML formátumra és illeszd be a manifestet',
    'Kattints a "Create" gombra, majd az "Install to Workspace" gombra',
    'Másold ki a Bot User OAuth Token-t (xoxb-...) a "OAuth & Permissions" oldalról',
    'Menj a "Basic Information" oldalra, "App-Level Tokens" szekció, kattints a "Generate Token and Scopes" gombra, adj hozzá a connections:write scope-ot, majd másold ki a tokent (xapp-...)',
  ]
}

// -- Token resolution --

export function getChannelToken(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'slack') return env['SLACK_BOT_TOKEN'] ?? ''
  if (provider === 'discord') return env['DISCORD_BOT_TOKEN'] ?? ''
  if (provider === 'googlechat') return env['GOOGLECHAT_PROJECT_ID'] ?? ''
  if (provider === 'teams') return env['TEAMS_BOT_APP_ID'] ?? ''
  return env['TELEGRAM_BOT_TOKEN'] ?? ''
}

export function getChannelChatId(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'slack') return env['SLACK_CHANNEL_ID'] ?? ''
  if (provider === 'discord') return env['DISCORD_CHANNEL_ID'] ?? ''
  if (provider === 'googlechat') return env['GOOGLECHAT_SPACE_ID'] ?? ''
  if (provider === 'teams') return env['TEAMS_ALLOWED_CONVERSATION_ID'] ?? ''
  return env['ALLOWED_CHAT_ID'] ?? ''
}

// -- Provider registry --

const providers: Record<ChannelProviderType, ChannelProvider> = {
  telegram: telegramProvider,
  slack: slackProvider,
  discord: discordProvider,
  googlechat: googlechatProvider,
  teams: teamsProvider,
}

// Every provider send is routed through the test-run marker: getProvider has
// many callers beyond notifyChannel (agent-process, channel-monitor, agent
// routes), and any of them reached from a test run must label its outbound
// message. markIfTestRun is a no-op in production and idempotent, so the
// wrapper is safe to layer under callers that already mark.
function withTestRunMarking(provider: ChannelProvider): ChannelProvider {
  return {
    ...provider,
    sendMessage: (token, chatId, text, parseMode, threadId) => threadId
      ? provider.sendMessage(token, chatId, markIfTestRun(text), parseMode, threadId)
      : provider.sendMessage(token, chatId, markIfTestRun(text), parseMode),
    sendPhoto: (token, chatId, photoPath, caption) =>
      provider.sendPhoto(token, chatId, photoPath, markIfTestRun(caption)),
  }
}

const markedProviders: Record<ChannelProviderType, ChannelProvider> = {
  telegram: withTestRunMarking(telegramProvider),
  slack: withTestRunMarking(slackProvider),
  discord: withTestRunMarking(discordProvider),
  googlechat: withTestRunMarking(googlechatProvider),
  teams: withTestRunMarking(teamsProvider),
}

export function getProvider(type: ChannelProviderType): ChannelProvider {
  return markedProviders[type]
}

const KNOWN_PROVIDER_TYPES: readonly ChannelProviderType[] = ['telegram', 'slack', 'discord', 'googlechat', 'teams']

export interface ProviderTypeResolution {
  /** The provider that will actually be used. */
  type: ChannelProviderType
  /** The configured value, trimmed. Empty string when nothing was configured. */
  raw: string
  /**
   * A value WAS configured, and it is not one this build knows. The caller gets
   * `telegram` regardless, which is why this flag has to travel with it.
   */
  unrecognised: boolean
}

/**
 * Resolve a configured channel-provider name, and say whether it was understood.
 *
 * Pure, so the substitution can be tested without touching a log. The falling
 * back itself is deliberate and stays: a build that refuses to start on an
 * unknown provider name would turn a typo into an outage. What is not
 * acceptable is doing it in silence, which is what GH #846 walked into.
 *
 * The reporter set `CHANNEL_PROVIDER=none` believing it meant "no channel", and
 * filed a crash against the respawn path. There is no `none` provider: the value
 * resolved to `telegram`, so their main session came up on a channel plugin they
 * had deliberately not configured. A typo (`telegran`, `Slack`) lands in exactly
 * the same place. The original report is the loud version of this; the silent
 * substitution is the one that is harder to notice and therefore worse.
 */
export function resolveProviderType(envValue: string | undefined): ProviderTypeResolution {
  const raw = (envValue ?? '').trim()
  const known = KNOWN_PROVIDER_TYPES.find((t) => t === raw)
  if (known) return { type: known, raw, unrecognised: false }
  return { type: 'telegram', raw, unrecognised: raw.length > 0 }
}

// Say it once per distinct bad value, not once per call: getProviderType is
// called on every isolated-config provision, and a warning that repeats becomes
// a warning nobody reads.
const announcedProviderValues = new Set<string>()

export function getProviderType(envValue: string | undefined): ChannelProviderType {
  const resolved = resolveProviderType(envValue)
  if (resolved.unrecognised && !announcedProviderValues.has(resolved.raw)) {
    announcedProviderValues.add(resolved.raw)
    logger.warn(
      { configured: resolved.raw, using: resolved.type, known: KNOWN_PROVIDER_TYPES },
      `Unknown channel provider "${resolved.raw}" -- falling back to "${resolved.type}". This is NOT what was configured: ` +
        `the session will come up on the ${resolved.type} plugin. There is no "none" provider; a channel-less agent is not a supported configuration today.`,
    )
  }
  return resolved.type
}

/** Test seam: the announce-once memory is process-wide by design. */
export function resetProviderTypeAnnouncements(): void {
  announcedProviderValues.clear()
}

// Compiled location is dist/channel-provider.js, so '..' is the install root --
// the same convention config.ts uses for PROJECT_ROOT. Computed locally because
// config.ts imports this module (importing it back would be circular).
const INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** TELEGRAM_STATE_DIR / SLACK_STATE_DIR / ... -- the env var the channel plugin
 *  itself honours. channels.sh exports it into the main session so the plugin,
 *  its hooks and this server all agree on one directory. */
export function channelStateDirEnvVar(provider: ChannelProviderType): string {
  return `${provider.toUpperCase()}_STATE_DIR`
}

// Main-agent channel state resolution (#915). The shared ~/.claude/channels/
// default meant ANY other Claude Code session on the host loaded the same bot
// token and silently took the bot over. The main agent's state is therefore
// install-scoped (<install>/.claude/channels/<provider>), the way sub-agents'
// always was. Order:
//   1. <PROVIDER>_STATE_DIR env override -- the value the plugin itself runs
//      with, so when set it is authoritative for every reader in this process.
//   2. legacy ~/.claude/channels/<provider>, but ONLY while it still holds the
//      .env and the install-scoped dir does not -- i.e. an install whose
//      channels.sh has not migrated yet. Readers must keep working against the
//      still-running legacy poller during that window.
//   3. install-scoped -- the default for migrated AND fresh installs, so a
//      first onboarding writes the token here and no shared-path copy is ever
//      born.
/** The ordering logic alone, pure so the contract is unit-testable without
 *  touching the real home directory. */
export function resolveMainChannelStateDir(opts: {
  envOverride: string | undefined
  installScoped: string
  legacy: string
  hasEnvFile: (dir: string) => boolean
}): string {
  if (opts.envOverride) return opts.envOverride
  if (opts.hasEnvFile(opts.legacy) && !opts.hasEnvFile(opts.installScoped)) return opts.legacy
  return opts.installScoped
}

export function channelStateDir(provider: ChannelProviderType, agentDir?: string): string {
  const subdir =
    provider === 'slack' ? 'slack'
    : provider === 'discord' ? 'discord'
    : provider === 'googlechat' ? 'googlechat'
    : provider === 'teams' ? 'teams'
    : 'telegram'
  if (agentDir) return join(agentDir, '.claude', 'channels', subdir)
  return resolveMainChannelStateDir({
    envOverride: process.env[channelStateDirEnvVar(provider)],
    installScoped: join(INSTALL_ROOT, '.claude', 'channels', subdir),
    legacy: join(homedir(), '.claude', 'channels', subdir),
    hasEnvFile: (dir) => existsSync(join(dir, '.env')),
  })
}

export function readChannelToken(provider: ChannelProviderType, envFilePath: string): string | null {
  if (!existsSync(envFilePath)) return null
  let content: string
  try {
    content = readFileSync(envFilePath, 'utf-8')
  } catch {
    return null
  }
  // Google Chat has no bot token; GOOGLECHAT_PROJECT_ID standing in the .env
  // signals the channel is configured (used by agentHasChannel / hasChannel).
  const key =
    provider === 'slack' ? 'SLACK_BOT_TOKEN'
    : provider === 'discord' ? 'DISCORD_BOT_TOKEN'
    : provider === 'googlechat' ? 'GOOGLECHAT_PROJECT_ID'
    : provider === 'teams' ? 'TEAMS_BOT_APP_ID'
    : 'TELEGRAM_BOT_TOKEN'
  // Anchored to a whole line: a commented-out `# SLACK_BOT_TOKEN=old` or a
  // prefixed `OLD_TELEGRAM_BOT_TOKEN=` must NOT match. Unanchored, a dead
  // token left commented in one .env shadowed the live one in the next lookup
  // location, and a commented-out GOOGLECHAT_PROJECT_ID still counted as a
  // configured channel for hasChannel/agentHasChannel.
  const match = content.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
  return match ? match[1].trim() : null
}

export function readChannelEnv(envFilePath: string, keys: readonly string[]): Record<string, string> {
  let content: string
  try {
    content = readFileSync(envFilePath, 'utf-8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const key of keys) {
    const match = content.match(new RegExp(`^\\s*${key}=(.+)$`, 'm'))
    if (match) out[key] = match[1].trim()
  }
  return out
}

// The Teams send needs all three TEAMS_BOT_* keys from ONE file, never mixed:
// a secret from a newer .env paired with an app id from a stale one would
// produce an Entra refusal that looks like a config error elsewhere. The FIRST
// file that has a TEAMS_BOT_APP_ID line wins; `files` is injectable so the
// lookup can be tested against temp files. When no file qualifies, the app-id
// stand-in from the caller becomes the appId with empty secret/tenant, which
// sendTeamsMessage reports as the incomplete-credentials config error.
export function readTeamsCreds(fallbackAppId: string, files?: string[]): TeamsCreds {
  const candidates = files ?? [join(INSTALL_ROOT, '.env'), join(channelStateDir('teams'), '.env')]
  for (const path of candidates) {
    const env = readChannelEnv(path, ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID'])
    if (env['TEAMS_BOT_APP_ID']) {
      return {
        appId: env['TEAMS_BOT_APP_ID'],
        secret: env['TEAMS_BOT_APP_PASSWORD'] ?? '',
        tenant: env['TEAMS_BOT_TENANT_ID'] ?? '',
      }
    }
  }
  return { appId: fallbackAppId, secret: '', tenant: '' }
}
