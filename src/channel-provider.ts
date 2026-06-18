import https from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from './logger.js'
import { formatForTelegram, splitMessage } from './format.js'

export type ChannelProviderType = 'telegram' | 'slack' | 'discord' | 'googlechat'

export interface ChannelProvider {
  readonly type: ChannelProviderType
  readonly pluginId: string
  readonly pluginPaneId: string
  readonly envKeys: string[]
  readonly stateDir: string
  readonly chatIdFormat: string
  sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
  sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
  formatMessage(text: string): string
  splitMessage(text: string): string[]
}

// -- Telegram implementation --

function telegramHttpPost(token: string, method: string, body: string, contentType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        if (res.statusCode === 200) {
          resolve()
        } else {
          reject(new Error(`Telegram API ${res.statusCode}`))
        }
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const telegramProvider: ChannelProvider = {
  type: 'telegram',
  pluginId: 'telegram@claude-plugins-official',
  pluginPaneId: 'plugin:telegram:telegram',
  envKeys: ['TELEGRAM_BOT_TOKEN'],
  stateDir: 'telegram',
  chatIdFormat: 'numeric (e.g. 1268077055)',

  async sendMessage(token, chatId, text, parseMode) {
    const payload: Record<string, string> = { chat_id: chatId, text }
    if (parseMode) payload.parse_mode = parseMode
    const body = JSON.stringify(payload)
    await telegramHttpPost(token, 'sendMessage', body, 'application/json')
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
        return { ok: true, botName: data.user || data.bot_id }
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
  return env['TELEGRAM_BOT_TOKEN'] ?? ''
}

export function getChannelChatId(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'slack') return env['SLACK_CHANNEL_ID'] ?? ''
  if (provider === 'discord') return env['DISCORD_CHANNEL_ID'] ?? ''
  if (provider === 'googlechat') return env['GOOGLECHAT_SPACE_ID'] ?? ''
  return env['ALLOWED_CHAT_ID'] ?? ''
}

// -- Provider registry --

const providers: Record<ChannelProviderType, ChannelProvider> = {
  telegram: telegramProvider,
  slack: slackProvider,
  discord: discordProvider,
  googlechat: googlechatProvider,
}

export function getProvider(type: ChannelProviderType): ChannelProvider {
  return providers[type]
}

export function getProviderType(envValue: string | undefined): ChannelProviderType {
  if (envValue === 'slack') return 'slack'
  if (envValue === 'discord') return 'discord'
  if (envValue === 'googlechat') return 'googlechat'
  return 'telegram'
}

export function channelStateDir(provider: ChannelProviderType, agentDir?: string): string {
  const base = agentDir
    ? join(agentDir, '.claude', 'channels')
    : join(homedir(), '.claude', 'channels')
  const subdir =
    provider === 'slack' ? 'slack'
    : provider === 'discord' ? 'discord'
    : provider === 'googlechat' ? 'googlechat'
    : 'telegram'
  return join(base, subdir)
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
    : 'TELEGRAM_BOT_TOKEN'
  const match = content.match(new RegExp(`${key}=(.+)`))
  return match ? match[1].trim() : null
}
