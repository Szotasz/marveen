import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'
import { PROJECT_ROOT, OLLAMA_URL } from '../../config.js'
import { logger } from '../../logger.js'
import {
  slugify as slugifyMcp,
  type McpListEntry,
} from '../../mcp-list-parser.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { readFileOr, AGENTS_BASE_DIR, listAgentNames } from '../agent-config.js'
import { getMcpListCache, refreshMcpListCache, purgeFromMcpListCache } from '../mcp-list.js'
import { readBody, json } from '../http-helpers.js'
import { shellEscape } from '../sanitize.js'
import { getExternalProjectPaths, addExternalProjectPath, removeExternalProjectPath, getGitHubRepos, installGitHubRepo, removeGitHubRepo, updateGitHubRepo, detectRequiredEnvVars } from '../dashboard-settings.js'
import { listSecrets, setSecret, getSecret, deleteSecret } from '../vault.js'
import {
  getBindings, addBinding, removeBinding, removeBindingsForSecret,
  syncSecret, syncAllBindings, scanMcpConfigs,
} from '../vault-bindings.js'
import type { RouteContext } from './types.js'

export async function tryHandleConnectors(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/connectors -- list every MCP server visible to Claude Code,
  // pulled from the local config files plus the cached `claude mcp list`
  // output. The CLI is not invoked here -- spawning every stdio / plugin
  // MCP for a health check would race the live Telegram bot.
  if (path === '/api/connectors' && method === 'GET') {
    type ConnectorEntry = {
      name: string
      status: string
      endpoint: string
      type: string
      source: 'plugin' | 'local-user' | 'local-project' | 'local' | 'claude.ai' | 'agent' | 'agent-project' | 'external-project'
      scope: string
    }
    const connectors: ConnectorEntry[] = []
    const globalSeen = new Set<string>()

    try {
      const settings = JSON.parse(readFileOr(join(homedir(), '.claude', 'settings.json'), '{}'))
      for (const pluginKey of Object.keys(settings.enabledPlugins || {})) {
        if (!settings.enabledPlugins[pluginKey]) continue
        const name = `plugin:${pluginKey.split('@')[0].toLowerCase()}`
        if (globalSeen.has(name)) continue
        globalSeen.add(name)
        connectors.push({ name, status: 'configured', endpoint: pluginKey, type: 'plugin', source: 'plugin', scope: 'plugin' })
      }
    } catch { /* ignore */ }

    const fileSources: Array<[string, 'local-project' | 'local-user', string]> = [
      [join(PROJECT_ROOT, '.mcp.json'), 'local-project', 'global'],
      [join(homedir(), '.claude.json'), 'local-user', 'global'],
    ]
    for (const [src, source, scope] of fileSources) {
      try {
        const parsed = JSON.parse(readFileOr(src, '{}'))
        const servers = parsed.mcpServers || {}
        for (const [name, cfg] of Object.entries(servers) as Array<[string, any]>) {
          if (globalSeen.has(name)) continue
          globalSeen.add(name)
          const endpoint = cfg?.url || cfg?.command || ''
          const type = cfg?.url ? 'remote' : 'local'
          connectors.push({ name, status: 'configured', endpoint: String(endpoint), type, source, scope })
        }
      } catch { /* ignore */ }
    }

    for (const entry of getMcpListCache().entries) {
      const key = entry.source === 'plugin' ? `plugin:${entry.normalizedId}` : entry.name
      if (globalSeen.has(key)) continue
      globalSeen.add(key)
      connectors.push({
        name: entry.name,
        status: entry.status === 'unknown' ? 'configured' : entry.status,
        endpoint: entry.endpoint,
        type: entry.source === 'claude.ai' ? 'remote' : 'local',
        source: entry.source === 'plugin' ? 'plugin'
               : entry.source === 'claude.ai' ? 'claude.ai'
               : 'local',
        scope: 'global',
      })
    }

    for (const agentName of listAgentNames()) {
      const agentMcpPath = join(AGENTS_BASE_DIR, agentName, '.mcp.json')
      try {
        const parsed = JSON.parse(readFileOr(agentMcpPath, '{}'))
        const servers = parsed.mcpServers || {}
        for (const [name, cfg] of Object.entries(servers) as Array<[string, any]>) {
          const endpoint = cfg?.url || cfg?.command || ''
          const type = cfg?.url ? 'remote' : 'local'
          connectors.push({ name, status: 'configured', endpoint: String(endpoint), type, source: 'agent', scope: `agent:${agentName}` })
        }
      } catch { /* ignore */ }

      const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
      if (existsSync(projectsDir)) {
        try {
          for (const proj of readdirSync(projectsDir)) {
            if (!statSync(join(projectsDir, proj)).isDirectory()) continue
            const projMcpPath = join(projectsDir, proj, '.mcp.json')
            try {
              const parsed = JSON.parse(readFileOr(projMcpPath, '{}'))
              const servers = parsed.mcpServers || {}
              for (const [name, cfg] of Object.entries(servers) as Array<[string, any]>) {
                const endpoint = cfg?.url || cfg?.command || ''
                const type = cfg?.url ? 'remote' : 'local'
                connectors.push({ name, status: 'configured', endpoint: String(endpoint), type, source: 'agent-project', scope: `project:${agentName}/${proj}` })
              }
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }

    for (const extPath of getExternalProjectPaths()) {
      try {
        const parsed = JSON.parse(readFileOr(join(extPath, '.mcp.json'), '{}'))
        const servers = parsed.mcpServers || {}
        const projName = basename(extPath)
        for (const [name, cfg] of Object.entries(servers) as Array<[string, any]>) {
          const endpoint = cfg?.url || cfg?.command || ''
          const type = cfg?.url ? 'remote' : 'local'
          connectors.push({ name, status: 'configured', endpoint: String(endpoint), type, source: 'external-project', scope: `project:external/${projName}` })
        }
      } catch { /* ignore */ }
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

  if (path === '/api/connectors/external-paths' && method === 'GET') {
    json(res, { paths: getExternalProjectPaths() })
    return true
  }

  if (path === '/api/connectors/external-paths' && method === 'POST') {
    const body = await readBody(req)
    const { path: p } = JSON.parse(body.toString()) as { path: string }
    const result = addExternalProjectPath(p)
    if (result.error) { json(res, { error: result.error }, 400); return true }
    json(res, { ok: true, paths: result.paths })
    return true
  }

  if (path === '/api/connectors/external-paths' && method === 'DELETE') {
    const body = await readBody(req)
    const { path: p } = JSON.parse(body.toString()) as { path: string }
    const paths = removeExternalProjectPath(p)
    json(res, { ok: true, paths })
    return true
  }

  if (path === '/api/connectors/github-repos' && method === 'GET') {
    json(res, { repos: getGitHubRepos() })
    return true
  }

  if (path === '/api/connectors/github-repos' && method === 'POST') {
    const body = await readBody(req)
    const { url, env } = JSON.parse(body.toString()) as { url: string, env?: Record<string, string> }
    if (!url?.trim()) { json(res, { error: 'URL is required' }, 400); return true }

    const envVarMapping: Record<string, string> = {}
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        const vaultId = `github-env-${key.toLowerCase()}-${Date.now()}`
        setSecret(vaultId, `${key} (GitHub repo)`, value)
        envVarMapping[key] = vaultId
      }
    }

    const result = await installGitHubRepo(url.trim(), Object.keys(envVarMapping).length > 0 ? envVarMapping : undefined)
    if (result.error) { json(res, { error: result.error }, 400); return true }
    json(res, { ok: true, repo: result.repo, requiredEnvVars: result.requiredEnvVars })
    return true
  }

  const githubRepoMatch = path.match(/^\/api\/connectors\/github-repos\/([^/]+)$/)
  if (githubRepoMatch && method === 'DELETE') {
    const name = decodeURIComponent(githubRepoMatch[1])
    const result = removeGitHubRepo(name)
    if (result.error) { json(res, { error: result.error }, 404); return true }
    json(res, { ok: true })
    return true
  }

  if (githubRepoMatch && method === 'PATCH') {
    const name = decodeURIComponent(githubRepoMatch[1])
    const result = updateGitHubRepo(name)
    if (result.error) { json(res, { error: result.error }, 400); return true }
    json(res, { ok: true })
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
    const searchPaths: Array<[string, string]> = [
      [join(PROJECT_ROOT, '.mcp.json'), 'project'],
      [join(homedir(), '.claude.json'), 'user'],
    ]
    for (const agentName of listAgentNames()) {
      searchPaths.push([join(AGENTS_BASE_DIR, agentName, '.mcp.json'), `agent:${agentName}`])
      const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
      if (existsSync(projectsDir)) {
        try {
          for (const proj of readdirSync(projectsDir)) {
            if (!statSync(join(projectsDir, proj)).isDirectory()) continue
            searchPaths.push([join(projectsDir, proj, '.mcp.json'), `project:${agentName}/${proj}`])
          }
        } catch { /* ignore */ }
      }
    }
    for (const extPath of getExternalProjectPaths()) {
      searchPaths.push([join(extPath, '.mcp.json'), `project:external/${basename(extPath)}`])
    }
    for (const [src, scope] of searchPaths) {
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
      type: 'stdio' | 'http' | 'sse'
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

      if ((data.type === 'http' || data.type === 'sse') && data.url) {
        const transport = data.type === 'sse' ? 'sse' : 'http'
        execSync(`claude mcp add --transport ${transport} ${scopeFlag} ${shellEscape(sanitizedName)} ${shellEscape(data.url)} 2>&1`, { timeout: 15000, encoding: 'utf-8' })
      } else if (data.type === 'stdio' && data.command) {
        const envFlags = data.env ? Object.entries(data.env).map(([k, v]) => `-e ${shellEscape(k)}=${shellEscape(v)}`).join(' ') : ''
        const argsStr = data.args ? data.args.split(/\s+/).filter(Boolean).map(a => shellEscape(a)).join(' ') : ''
        execSync(`claude mcp add ${scopeFlag} ${shellEscape(sanitizedName)} ${envFlags} -- ${shellEscape(data.command)} ${argsStr} 2>&1`, { timeout: 15000, encoding: 'utf-8' })
      } else {
        json(res, { error: 'URL (http/sse) or command (stdio) required' }, 400)
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
    let removed = 0
    const mcpFiles = [
      join(PROJECT_ROOT, '.mcp.json'),
      join(homedir(), '.claude.json'),
    ]
    for (const agentName of listAgentNames()) {
      mcpFiles.push(join(AGENTS_BASE_DIR, agentName, '.mcp.json'))
      const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
      if (existsSync(projectsDir)) {
        try {
          for (const proj of readdirSync(projectsDir)) {
            if (statSync(join(projectsDir, proj)).isDirectory()) {
              mcpFiles.push(join(projectsDir, proj, '.mcp.json'))
            }
          }
        } catch { /* ignore */ }
      }
    }
    for (const extPath of getExternalProjectPaths()) {
      mcpFiles.push(join(extPath, '.mcp.json'))
    }
    for (const mcpPath of mcpFiles) {
      try {
        const parsed = JSON.parse(readFileOr(mcpPath, '{}'))
        if (parsed.mcpServers && parsed.mcpServers[name]) {
          delete parsed.mcpServers[name]
          atomicWriteFileSync(mcpPath, JSON.stringify(parsed, null, 2))
          removed++
        }
      } catch { /* skip unreadable files */ }
    }
    if (removed > 0) {
      purgeFromMcpListCache(name)
      json(res, { ok: true, removed })
    } else if (purgeFromMcpListCache(name)) {
      json(res, { ok: true, removed: 0, purgedFromCache: true })
    } else {
      json(res, { error: 'Connector not found in any config' }, 404)
    }
    return true
  }

  const connectorAssignMatch = path.match(/^\/api\/connectors\/(.+)\/assign$/)
  if (connectorAssignMatch && method === 'POST') {
    const connectorName = decodeURIComponent(connectorAssignMatch[1])
    const body = await readBody(req)
    const { agents: targetAgents, allAgents: visibleAgents } = JSON.parse(body.toString()) as { agents: string[], allAgents?: string[] }

    if (connectorName.startsWith('plugin:')) {
      json(res, { ok: true, note: 'plugin:* connectors are global to every agent -- nothing to assign.' })
      return true
    }

    let connectorConfig: any = null
    const configSources = [
      join(PROJECT_ROOT, '.mcp.json'),
      join(homedir(), '.claude.json'),
    ]
    for (const agentName of listAgentNames()) {
      configSources.push(join(AGENTS_BASE_DIR, agentName, '.mcp.json'))
      const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
      if (existsSync(projectsDir)) {
        try {
          for (const proj of readdirSync(projectsDir)) {
            if (statSync(join(projectsDir, proj)).isDirectory()) {
              configSources.push(join(projectsDir, proj, '.mcp.json'))
            }
          }
        } catch { /* ignore */ }
      }
    }
    for (const extPath of getExternalProjectPaths()) {
      configSources.push(join(extPath, '.mcp.json'))
    }
    for (const src of configSources) {
      try {
        const parsed = JSON.parse(readFileOr(src, '{}'))
        if (parsed.mcpServers && parsed.mcpServers[connectorName]) {
          connectorConfig = parsed.mcpServers[connectorName]
          break
        }
      } catch { /* fall through */ }
    }
    if (!connectorConfig) { json(res, { error: 'Connector not found' }, 404); return true }

    const targetSet = new Set(targetAgents)
    for (const agentName of targetAgents) {
      const mcpPath = join(AGENTS_BASE_DIR, agentName, '.mcp.json')
      let mcpConfig: any = {}
      try { mcpConfig = JSON.parse(readFileOr(mcpPath, '{}')) } catch {}
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {}
      mcpConfig.mcpServers[connectorName] = connectorConfig
      atomicWriteFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
    }

    if (visibleAgents) {
      for (const agentName of visibleAgents) {
        if (targetSet.has(agentName)) continue
        const mcpPath = join(AGENTS_BASE_DIR, agentName, '.mcp.json')
        try {
          const mcpConfig = JSON.parse(readFileOr(mcpPath, '{}'))
          if (mcpConfig.mcpServers && mcpConfig.mcpServers[connectorName]) {
            delete mcpConfig.mcpServers[connectorName]
            atomicWriteFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
          }
        } catch { /* skip */ }
      }
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

  // === Vault ===
  if (path === '/api/vault' && method === 'GET') {
    json(res, { secrets: listSecrets() })
    return true
  }

  if (path === '/api/vault' && method === 'POST') {
    const body = await readBody(req)
    const { id, label, value } = JSON.parse(body.toString()) as { id: string, label: string, value: string }
    if (!id?.trim() || !value) { json(res, { error: 'id and value required' }, 400); return true }
    setSecret(id.trim(), label || id.trim(), value)
    const syncResult = syncSecret(id.trim())
    json(res, { ok: true, synced: syncResult.updated })
    return true
  }

  const vaultMatch = path.match(/^\/api\/vault\/([^/]+)$/)
  if (vaultMatch && method === 'GET') {
    const id = decodeURIComponent(vaultMatch[1])
    const val = getSecret(id)
    if (val === null) { json(res, { error: 'Not found' }, 404); return true }
    json(res, { id, value: val })
    return true
  }

  if (vaultMatch && method === 'DELETE') {
    const id = decodeURIComponent(vaultMatch[1])
    if (!deleteSecret(id)) { json(res, { error: 'Not found' }, 404); return true }
    removeBindingsForSecret(id)
    json(res, { ok: true })
    return true
  }

  // === Vault Bindings ===
  if (path === '/api/vault/bindings' && method === 'GET') {
    json(res, { bindings: getBindings() })
    return true
  }

  if (path === '/api/vault/bindings' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      vaultSecretId: string
      envVar: string
      targets: Array<{ mcpFilePath: string, serverName: string }>
    }
    if (!data.vaultSecretId || !data.envVar || !data.targets?.length) {
      json(res, { error: 'vaultSecretId, envVar, and targets required' }, 400)
      return true
    }
    addBinding(data)
    const syncResult = syncSecret(data.vaultSecretId)
    json(res, { ok: true, synced: syncResult.updated, errors: syncResult.errors })
    return true
  }

  const bindingDeleteMatch = path.match(/^\/api\/vault\/bindings\/([^/]+)\/([^/]+)$/)
  if (bindingDeleteMatch && method === 'DELETE') {
    const secretId = decodeURIComponent(bindingDeleteMatch[1])
    const envVar = decodeURIComponent(bindingDeleteMatch[2])
    if (!removeBinding(secretId, envVar)) { json(res, { error: 'Binding not found' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/vault/sync' && method === 'POST') {
    const result = syncAllBindings()
    json(res, { ok: true, ...result })
    return true
  }

  // === Vault Scan & Import ===
  if (path === '/api/vault/scan' && method === 'GET') {
    json(res, { findings: scanMcpConfigs() })
    return true
  }

  if (path === '/api/vault/import' && method === 'POST') {
    const body = await readBody(req)
    const { imports: importRequests } = JSON.parse(body.toString()) as {
      imports: Array<{
        serverName: string
        envVar: string
        vaultId: string
        label: string
        createBinding: boolean
        targets: Array<{ mcpFilePath: string, serverName: string }>
      }>
    }
    let imported = 0
    let bound = 0
    const errors: string[] = []
    for (const imp of importRequests) {
      let value: string | null = null
      for (const target of imp.targets) {
        try {
          const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
          const envVal = content?.mcpServers?.[target.serverName]?.env?.[imp.envVar]
          if (envVal && typeof envVal === 'string') { value = envVal; break }
        } catch { /* skip */ }
      }
      if (!value) {
        errors.push(`Could not read value for ${imp.envVar} from ${imp.serverName}`)
        continue
      }
      setSecret(imp.vaultId, imp.label, value)
      imported++
      if (imp.createBinding && imp.targets.length > 0) {
        addBinding({ vaultSecretId: imp.vaultId, envVar: imp.envVar, targets: imp.targets })
        bound++
      }
    }
    json(res, { ok: true, imported, bound, errors })
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
