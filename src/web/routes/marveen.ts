import { existsSync, unlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import {
  PROJECT_ROOT, OWNER_NAME, BOT_NAME, BRAND_NAME, MAIN_AGENT_ID, CHANNEL_PROVIDER,
  KANBAN_LABEL_COLORS,
} from '../../config.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { readMarveenTelegramConfig, readMarveenDiscordConfig, readMarveenSlackConfig, readMarveenGooglechatConfig, sendMarveenAvatarChange } from '../telegram.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import { readFileOr } from '../agent-config.js'
import { parseMultipart } from '../multipart.js'
import { readBody, json, serveFile } from '../http-helpers.js'
import { MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { readActiveModelFromProjectDir, readContextTokensFromProjectDir } from '../active-model.js'
import { readAutoRestartConfig } from '../auto-restart-store.js'
import type { RouteContext } from './types.js'

function getActiveMarveenModel(): string {
  return readActiveModelFromProjectDir(PROJECT_ROOT) ?? 'unknown'
}

// Pure identity-core of the /api/marveen payload: the brand-relevant fields the
// dashboard chrome + agent routing depend on. Extracted so the mapping (display
// name -> name, product brand -> brandName, canonical id -> agentId) is provable
// for any non-default identity, independent of the route's file I/O.
export interface MarveenIdentityCore {
  name: string
  brandName: string
  agentId: string
  autoRestartId: string
  role: 'main'
}
export function buildMarveenIdentityCore(
  botName: string,
  brandName: string,
  mainAgentId: string,
): MarveenIdentityCore {
  return {
    name: botName,
    brandName,
    agentId: mainAgentId,
    autoRestartId: mainAgentId,
    role: 'main',
  }
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
    const gc = readMarveenGooglechatConfig()
    // Brand-relevant identity core. `name` = main agent display name (BOT_NAME),
    // `brandName` = product brand for the dashboard chrome (defaults to BOT_NAME;
    // the client falls back to its own HTML default "Marveen" if absent on a
    // legacy backend), `agentId` = canonical MAIN_AGENT_ID so the dashboard can
    // hit /api/agents/<id>/skills for the main agent.
    const idCore = buildMarveenIdentityCore(BOT_NAME, BRAND_NAME, MAIN_AGENT_ID)
    json(res, {
      ...idCore,
      description,
      model: getActiveMarveenModel(),
      tmuxSession: MAIN_CHANNELS_SESSION,
      running: true,
      // Auto-restart applies to the main channels session too; key it by the
      // orchestrator id (autoRestartId, part of idCore) so the UI PUTs to the
      // right store entry.
      autoRestart: readAutoRestartConfig(MAIN_AGENT_ID),
      contextTokens: readContextTokensFromProjectDir(PROJECT_ROOT),
      hasTelegram: tg.hasTelegram,
      hasDiscord: dc.hasDiscord,
      hasSlack: sl.hasSlack,
      hasGooglechat: gc.hasGooglechat,
      telegramBotUsername: tg.botUsername,
      personality: soulSection,
      claudeMd,
      soulMd,
      mcpJson,
      readonly: true,
      // Dashboard kliens defaultja a provider-dropdown-hoz: a backend
      // CHANNEL_PROVIDER env-jébe pinneljük, hogy a UI ne hardcode-olt
      // 'telegram'-mal induljon.
      channelProvider: CHANNEL_PROVIDER,
      // Resolved through the settings overrides layer so the UI hot-reloads.
      kanbanAging: {
        warnH: getEffectiveSettingValue('KANBAN_AGING_WARN_H'),
        cautionH: getEffectiveSettingValue('KANBAN_AGING_CAUTION_H'),
        criticalH: getEffectiveSettingValue('KANBAN_AGING_CRITICAL_H'),
        warnColor: getEffectiveSettingValue('KANBAN_AGING_WARN_COLOR'),
        cautionColor: getEffectiveSettingValue('KANBAN_AGING_CAUTION_COLOR'),
        criticalColor: getEffectiveSettingValue('KANBAN_AGING_CRITICAL_COLOR'),
      },
      // Resolved through the settings overrides layer (override > .env >
      // registry default) instead of the boot-time config.ts constants, so a
      // value saved on the Settings page takes effect immediately -- no
      // process restart needed for these 9 keys.
      kanbanWip: {
        limits: {
          planned: getEffectiveSettingValue('KANBAN_WIP_PLANNED'),
          in_progress: getEffectiveSettingValue('KANBAN_WIP_IN_PROGRESS'),
          waiting: getEffectiveSettingValue('KANBAN_WIP_WAITING'),
          done: getEffectiveSettingValue('KANBAN_WIP_DONE'),
        },
        warnPct: getEffectiveSettingValue('KANBAN_WIP_WARN_PCT'),
        okColor: getEffectiveSettingValue('KANBAN_WIP_OK_COLOR'),
        warnColor: getEffectiveSettingValue('KANBAN_WIP_WARN_COLOR'),
        fullColor: getEffectiveSettingValue('KANBAN_WIP_FULL_COLOR'),
        overColor: getEffectiveSettingValue('KANBAN_WIP_OVER_COLOR'),
      },
      kanbanSwimlanes: {
        defaultGroup: getEffectiveSettingValue('KANBAN_SWIMLANE_DEFAULT_GROUP'),
        separatorColor: getEffectiveSettingValue('KANBAN_SWIMLANE_SEPARATOR_COLOR') || null,
      },
      kanbanLabels: {
        colors: KANBAN_LABEL_COLORS,
      },
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
      if (existsSync(p)) { serveFile(req, res, p); return true }
    }
    const fallback = join(webDir, 'avatars', '01_robot.png')
    if (existsSync(fallback)) { serveFile(req, res, fallback); return true }
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
