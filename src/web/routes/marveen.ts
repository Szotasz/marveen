import { existsSync, unlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { PROJECT_ROOT, OWNER_NAME, BOT_NAME, MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../../config.js'
import { readMarveenTelegramConfig, readMarveenDiscordConfig, readMarveenSlackConfig, sendMarveenAvatarChange } from '../telegram.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { readFileOr } from '../agent-config.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { readActiveModelFromProjectDir } from '../active-model.js'
import type { RouteContext } from './types.js'

function getActiveMarveenModel(): string {
  return readActiveModelFromProjectDir(PROJECT_ROOT) ?? 'unknown'
}

export async function tryHandleMarveen(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/marveen' && method === 'GET') {
    const claudeMd = readFileOr(join(PROJECT_ROOT, 'CLAUDE.md'), '')
    const soulMd = readFileOr(join(PROJECT_ROOT, 'SOUL.md'), '')
    const mcpJson = readFileOr(join(PROJECT_ROOT, '.mcp.json'), '')
    const soulSection = claudeMd.match(/## Személyiség\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
      || claudeMd.match(/## Szemelyiseg\n\n([\s\S]*?)(?=\n## )/)?.[1]?.trim()
      || ''
    const firstLine = claudeMd.match(/^Te .+$/m)?.[0]?.trim() || ''
    const descFromPersonality = soulSection.split('\n').filter(l => l.trim()).slice(0, 2).join(' ').slice(0, 200)
    const description = firstLine || descFromPersonality || `${OWNER_NAME} AI asszisztense`
    const tg = readMarveenTelegramConfig()
    const dc = readMarveenDiscordConfig()
    const sl = readMarveenSlackConfig()
    json(res, {
      name: BOT_NAME,
      // Canonical agent id (MAIN_AGENT_ID, e.g. "gorcsevivan") so the dashboard
      // can hit /api/agents/<id>/skills for the main agent -- the display name
      // (BOT_NAME) is not a valid agent-dir id.
      agentId: MAIN_AGENT_ID,
      description,
      model: getActiveMarveenModel(),
      tmuxSession: MAIN_CHANNELS_SESSION,
      running: true,
      hasTelegram: tg.hasTelegram,
      hasDiscord: dc.hasDiscord,
      hasSlack: sl.hasSlack,
      telegramBotUsername: tg.botUsername,
      role: 'main',
      personality: soulSection,
      claudeMd,
      soulMd,
      mcpJson,
      readonly: true,
      // Dashboard kliens defaultja a provider-dropdown-hoz: a backend
      // CHANNEL_PROVIDER env-jébe pinneljük, hogy a UI ne hardcode-olt
      // 'telegram'-mal induljon.
      channelProvider: CHANNEL_PROVIDER,
    })
    return true
  }

  // Intentionally read-only: Marveen's CLAUDE.md / SOUL.md / .mcp.json must be
  // edited from the filesystem or via a Telegram request to Marveen herself,
  // not through the dashboard. A leaked dashboard token would otherwise allow
  // remote identity rewrite of the live agent.
  if (path === '/api/marveen' && method === 'PUT') {
    json(res, { ok: true, readonly: true })
    return true
  }

  if (path === '/api/marveen/restart' && method === 'POST') {
    const result = hardRestartMarveenChannels()
    if (!result.ok) { json(res, { error: result.error || 'Restart failed' }, 500); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/marveen/avatar' && method === 'GET') {
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`)
      if (existsSync(p)) { serveFile(res, p); return true }
    }
    const fallback = join(webDir, 'avatars', '01_robot.png')
    if (existsSync(fallback)) { serveFile(res, fallback); return true }
    res.writeHead(404); res.end()
    return true
  }

  if (path === '/api/marveen/avatar' && method === 'POST') {
    const body = await readBody(req)
    const contentType = req.headers['content-type'] || ''

    for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
      const p = join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`)
      if (existsSync(p)) unlinkSync(p)
    }

    if (contentType.includes('application/json')) {
      const { galleryAvatar } = JSON.parse(body.toString()) as { galleryAvatar: string }
      if (!galleryAvatar) { json(res, { error: 'No avatar specified' }, 400); return true }
      if (galleryAvatar.includes('..') || galleryAvatar.includes('/') || galleryAvatar.includes('\\')) {
        json(res, { error: 'Invalid avatar name' }, 400)
        return true
      }
      const srcPath = join(webDir, 'avatars', galleryAvatar)
      if (!existsSync(srcPath)) { json(res, { error: 'Avatar not found' }, 404); return true }
      const destPath = join(PROJECT_ROOT, 'store', `marveen-avatar${extname(galleryAvatar) || '.png'}`)
      copyFileSync(srcPath, destPath)
      sendMarveenAvatarChange(destPath).catch(() => {})
    } else {
      const { file } = parseMultipart(body, contentType)
      if (!file) { json(res, { error: 'No file uploaded' }, 400); return true }
      const destPath = join(PROJECT_ROOT, 'store', `marveen-avatar${extname(file.name) || '.png'}`)
      writeFileSync(destPath, file.data)
      sendMarveenAvatarChange(destPath).catch(() => {})
    }
    json(res, { ok: true })
    return true
  }

  return false
}
