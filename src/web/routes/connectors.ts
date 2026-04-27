import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { PROJECT_ROOT, OLLAMA_URL } from '../../config.js'
import { logger } from '../../logger.js'
import {
  slugify as slugifyMcp,
  type McpListEntry,
} from '../../mcp-list-parser.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { readFileOr } from '../agent-config.js'
import { getMcpListCache, refreshMcpListCache } from '../mcp-list.js'
import { readBody, json } from '../http-helpers.js'
import { shellEscape } from '../sanitize.js'
import type { RouteContext } from './types.js'

export async function tryHandleConnectors(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/connectors -- list every MCP server visible to Claude Code,
  // pulled from the local config files plus the cached `claude mcp list`
  // output. The CLI is not invoked here -- spawning every stdio / plugin
  // MCP for a health check would race the live Telegram bot.
  if (path === '/api/connectors' && method === 'GET') {
    const connectors: Array<{
      name: string
      status: string
      endpoint: string
      type: string
      source: 'plugin' | 'local-user' | 'local-project' | 'local' | 'claude.ai'
    }> = []
    const seen = new Set<string>()

    try {
      const settings = JSON.parse(readFileOr(join(homedir(), '.claude', 'settings.json'), '{}'))
      for (const pluginKey of Object.keys(settings.enabledPlugins || {})) {
        if (!settings.enabledPlugins[pluginKey]) continue
        const name = `plugin:${pluginKey.split('@')[0].toLowerCase()}`
        if (seen.has(name)) continue
        seen.add(name)
        connectors.push({ name, status: 'configured', endpoint: pluginKey, type: 'plugin', source: 'plugin' })
      }
    } catch { /* ignore */ }

    const fileSources: Array<[string, 'local-project' | 'local-user']> = [
      [join(PROJECT_ROOT, '.mcp.json'), 'local-project'],
      [join(homedir(), '.claude.json'), 'local-user'],
    ]
    for (const [src, source] of fileSources) {
      try {
        const parsed = JSON.parse(readFileOr(src, '{}'))
        const servers = parsed.mcpServers || {}
        for (const [name, cfg] of Object.entries(servers) as Array<[string, any]>) {
          if (seen.has(name)) continue
          seen.add(name)
          const endpoint = cfg?.url || cfg?.command || ''
          const type = cfg?.url ? 'remote' : 'local'
          connectors.push({ name, status: 'configured', endpoint: String(endpoint), type, source })
        }
      } catch { /* ignore */ }
    }

    for (const entry of getMcpListCache().entries) {
      const key = entry.source === 'plugin' ? `plugin:${entry.normalizedId}` : entry.name
      if (seen.has(key)) continue
      seen.add(key)
      connectors.push({
        name: entry.name,
        status: entry.status === 'unknown' ? 'configured' : entry.status,
        endpoint: entry.endpoint,
        type: entry.source === 'claude.ai' ? 'remote' : 'local',
        source: entry.source === 'plugin' ? 'plugin'
               : entry.source === 'claude.ai' ? 'claude.ai'
               : 'local',
      })
    }

    json(res, connectors)
    return true
  }

  if (path === '/api/connectors/status' && method === 'GET') {
    const cache = getMcpListCache()
    json(res, {
      cacheLastRefreshed: cache.lastRefreshed,
      cacheError: cache.error,
      refreshing: cache.refreshing,
    })
    return true
  }

  if (path === '/api/connectors/refresh' && method === 'POST') {
    const cache = await refreshMcpListCache()
    const httpStatus = cache.error ? 502 : 200
    json(res, {
      ok: !cache.error,
      count: cache.entries.length,
      lastRefreshed: cache.lastRefreshed,
      error: cache.error,
    }, httpStatus)
    return true
  }

  const connectorDetailMatch = path.match(/^\/api\/connectors\/(.+)$/)
  if (connectorDetailMatch && method === 'GET' && !path.includes('/assign')) {
    const name = decodeURIComponent(connectorDetailMatch[1])
    if (name.startsWith('plugin:')) {
      try {
        const settings = JSON.parse(readFileOr(join(homedir(), '.claude', 'settings.json'), '{}'))
        const rawSuffix = name.slice('plugin:'.length)
        const segments = rawSuffix.split(':')
        const plain = (segments[segments.length - 1] || rawSuffix).toLowerCase()
        const enabled = settings.enabledPlugins || {}
        const match = Object.keys(enabled).find(
          k => enabled[k] && k.split('@')[0].toLowerCase() === plain,
        )
        if (!match) { json(res, { error: 'Connector not found' }, 404); return true }
        json(res, { name, scope: 'user', status: 'configured', type: 'plugin', command: match, args: '', env: {} })
        return true
      } catch {
        json(res, { error: 'Connector not found' }, 404)
        return true
      }
    }
    for (const [src, scope] of [[join(PROJECT_ROOT, '.mcp.json'), 'project' as const], [join(homedir(), '.claude.json'), 'user' as const]]) {
      try {
        const parsed = JSON.parse(readFileOr(src, '{}'))
        const cfg = (parsed.mcpServers || {})[name]
        if (!cfg) continue
        const type = cfg.url ? 'remote' : 'local'
        const env: Record<string, string> = {}
        for (const k of Object.keys(cfg.env || {})) env[k] = '***'
        json(res, {
          name,
          scope,
          status: 'configured',
          type,
          command: cfg.command || cfg.url || '',
          args: Array.isArray(cfg.args) ? cfg.args.join(' ') : '',
          env,
        })
        return true
      } catch { /* fall through */ }
    }
    json(res, { error: 'Connector not found' }, 404)
    return true
  }

  if (path === '/api/connectors' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      name: string
      type: 'remote' | 'local'
      url?: string
      command?: string
      args?: string
      scope?: string
      env?: Record<string, string>
    }

    if (!data.name?.trim()) { json(res, { error: 'Name is required' }, 400); return true }

    const rawName = data.name.trim()
    const sanitizedName = rawName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!sanitizedName) {
      json(res, { error: 'Name must contain at least one letter, number, hyphen, or underscore' }, 400)
      return true
    }
    const nameChanged = sanitizedName !== rawName

    try {
      const scopeFlag = data.scope === 'project' ? '-s project' : '-s user'

      if (data.type === 'remote' && data.url) {
        execSync(`claude mcp add --transport http ${scopeFlag} ${shellEscape(sanitizedName)} ${shellEscape(data.url)} 2>&1`, { timeout: 15000, encoding: 'utf-8' })
      } else if (data.type === 'local' && data.command) {
        const envFlags = data.env ? Object.entries(data.env).map(([k, v]) => `-e ${shellEscape(k)}=${shellEscape(v)}`).join(' ') : ''
        const argsStr = data.args ? shellEscape(data.args) : ''
        execSync(`claude mcp add ${scopeFlag} ${shellEscape(sanitizedName)} ${envFlags} -- ${shellEscape(data.command)} ${argsStr} 2>&1`, { timeout: 15000, encoding: 'utf-8' })
      } else {
        json(res, { error: 'URL (remote) or command (local) required' }, 400)
        return true
      }

      json(res, { ok: true, name: sanitizedName, nameChanged })
    } catch (err: any) {
      json(res, { error: err.message || 'Failed to add connector' }, 500)
    }
    return true
  }

  if (connectorDetailMatch && method === 'DELETE' && !path.includes('/assign')) {
    const name = decodeURIComponent(connectorDetailMatch[1])
    try {
      try {
        execSync(`claude mcp remove ${shellEscape(name)} -s project 2>&1`, { timeout: 10000 })
      } catch {
        execSync(`claude mcp remove ${shellEscape(name)} -s user 2>&1`, { timeout: 10000 })
      }
      json(res, { ok: true })
    } catch {
      json(res, { error: 'Failed to remove connector' }, 500)
    }
    return true
  }

  const connectorAssignMatch = path.match(/^\/api\/connectors\/(.+)\/assign$/)
  if (connectorAssignMatch && method === 'POST') {
    const connectorName = decodeURIComponent(connectorAssignMatch[1])
    const body = await readBody(req)
    const { agents: targetAgents } = JSON.parse(body.toString()) as { agents: string[] }

    if (connectorName.startsWith('plugin:')) {
      json(res, { ok: true, note: 'plugin:* connectors are global to every agent -- nothing to assign.' })
      return true
    }

    let connectorConfig: any = null
    for (const src of [join(PROJECT_ROOT, '.mcp.json'), join(homedir(), '.claude.json')]) {
      try {
        const parsed = JSON.parse(readFileOr(src, '{}'))
        if (parsed.mcpServers && parsed.mcpServers[connectorName]) {
          connectorConfig = parsed.mcpServers[connectorName]
          break
        }
      } catch { /* fall through */ }
    }
    if (!connectorConfig) { json(res, { error: 'Connector not found' }, 404); return true }

    const AGENTS_BASE = join(PROJECT_ROOT, 'agents')
    for (const agentName of targetAgents) {
      const mcpPath = join(AGENTS_BASE, agentName, '.mcp.json')
      if (!existsSync(mcpPath)) continue
      let mcpConfig: any = {}
      try { mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8')) } catch {}
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}
      mcpConfig.mcpServers[connectorName] = connectorConfig
      atomicWriteFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
    }
    json(res, { ok: true })
    return true
  }

  // === MCP Catalog ===
  if (path === '/api/mcp-catalog' && method === 'GET') {
    try {
      const catalogPath = join(PROJECT_ROOT, 'mcp-catalog.json')
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as any[]

      const installedSource = new Map<string, McpListEntry['source']>()
      for (const entry of getMcpListCache().entries) {
        if (!installedSource.has(entry.normalizedId)) {
          installedSource.set(entry.normalizedId, entry.source)
        }
      }

      const result = catalog.map(item => {
        const itemId = slugifyMcp(String(item.id ?? ''))
        const itemNameSlug = slugifyMcp(String(item.name ?? ''))
        const source = installedSource.get(itemId) || installedSource.get(itemNameSlug)
        return {
          ...item,
          installed: source !== undefined,
          installedSource: source,
        }
      })

      json(res, result)
    } catch (err) {
      logger.error({ err }, 'Failed to load MCP catalog')
      json(res, { error: 'Failed to load catalog' }, 500)
    }
    return true
  }

  const catalogInstallMatch = path.match(/^\/api\/mcp-catalog\/([^/]+)\/install$/)
  if (catalogInstallMatch && method === 'POST') {
    const id = decodeURIComponent(catalogInstallMatch[1])
    try {
      const catalogPath = join(PROJECT_ROOT, 'mcp-catalog.json')
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as any[]
      const item = catalog.find(c => c.id === id)
      if (!item) { json(res, { error: 'Item not found in catalog' }, 404); return true }

      const body = await readBody(req)
      let envData: Record<string, string> = {}
      try {
        const parsed = JSON.parse(body.toString())
        if (parsed.env) envData = parsed.env
      } catch { /* no body or invalid json - that's ok */ }

      const cliName = item.id

      if (item.type === 'local') {
        const allEnv = { ...item.env, ...envData }
        const envFlags = Object.entries(allEnv)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => `-e ${shellEscape(k)}=${shellEscape(v as string)}`)
          .join(' ')

        const argsStr = (item.args || []).map((a: string) => shellEscape(a)).join(' ')
        const cmd = `claude mcp add --scope user ${shellEscape(cliName)} ${envFlags} -- ${shellEscape(item.command)} ${argsStr} 2>&1`
        execSync(cmd, { timeout: 30000, encoding: 'utf-8' })
      } else if (item.type === 'remote') {
        const url = item.url
        if (!url) { json(res, { error: 'Remote item has no URL' }, 400); return true }
        execSync(`claude mcp add --transport sse --scope user ${shellEscape(cliName)} ${shellEscape(url)} 2>&1`, { timeout: 30000, encoding: 'utf-8' })
      }

      let message = 'Telepítve'
      if (item.authType === 'oauth' && item.authNote) {
        message = `Telepítve. ${item.authNote}`
      }

      json(res, { ok: true, message })
    } catch (err: any) {
      logger.error({ err }, 'Failed to install MCP from catalog')
      json(res, { error: err.message || 'Failed to install' }, 500)
    }
    return true
  }

  const catalogUninstallMatch = path.match(/^\/api\/mcp-catalog\/([^/]+)\/uninstall$/)
  if (catalogUninstallMatch && method === 'DELETE') {
    const id = decodeURIComponent(catalogUninstallMatch[1])
    try {
      const catalogPath = join(PROJECT_ROOT, 'mcp-catalog.json')
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as any[]
      const item = catalog.find(c => c.id === id)
      if (!item) { json(res, { error: 'Item not found in catalog' }, 404); return true }

      const cliName = item.id
      try {
        execSync(`claude mcp remove ${shellEscape(cliName)} -s user 2>&1`, { timeout: 15000 })
      } catch {
        try {
          execSync(`claude mcp remove ${shellEscape(cliName)} -s project 2>&1`, { timeout: 15000 })
        } catch { /* ignore if not found anywhere */ }
      }

      json(res, { ok: true, message: 'Eltávolítva' })
    } catch (err: any) {
      logger.error({ err }, 'Failed to uninstall MCP from catalog')
      json(res, { error: err.message || 'Failed to uninstall' }, 500)
    }
    return true
  }

  // === Ollama ===
  if (path === '/api/ollama/models' && method === 'GET') {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) })
      const data = await resp.json() as { models?: { name: string; size: number; details?: { parameter_size?: string } }[] }
      const models = (data.models || []).filter(m => !m.name.includes('embed')).map(m => ({
        name: m.name,
        size: Math.round(m.size / 1024 / 1024 / 1024 * 10) / 10 + ' GB',
        params: m.details?.parameter_size || '',
      }))
      json(res, models)
    } catch {
      json(res, [])
    }
    return true
  }

  return false
}
