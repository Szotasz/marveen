import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { readFileOr, AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { getSecret, listSecrets } from './vault.js'
import { getExternalProjectPaths } from './dashboard-settings.js'
import { logger } from '../logger.js'

const BINDINGS_PATH = join(PROJECT_ROOT, 'store', 'vault-bindings.json')

export interface VaultBindingTarget {
  mcpFilePath: string
  serverName: string
}

export interface VaultBinding {
  vaultSecretId: string
  envVar: string
  targets: VaultBindingTarget[]
}

interface BindingsStore {
  bindings: VaultBinding[]
}

const SENSITIVE_PATTERNS = [
  /_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /_PASSWORD$/i, /_PASS$/i,
  /^API_/i, /^AUTH_/i, /^OAUTH_/i,
  /PASSWORD/i, /CREDENTIAL/i, /ACCESS_KEY/i,
]

const NON_SENSITIVE_VALUE_PATTERNS = [
  /^(true|false)$/i,
  /^https?:\/\//,
  /^\d+$/,
  /^\//,
  /^\$\{/,
]

export interface ScanFinding {
  mcpFilePath: string
  serverName: string
  envVar: string
  maskedValue: string
  suggestedVaultId: string
  alreadyInVault: boolean
  existingVaultId?: string
}

export interface SyncResult {
  updated: number
  errors: string[]
}

function readBindings(): BindingsStore {
  try { return JSON.parse(readFileSync(BINDINGS_PATH, 'utf-8')) }
  catch { return { bindings: [] } }
}

function writeBindings(store: BindingsStore): void {
  atomicWriteFileSync(BINDINGS_PATH, JSON.stringify(store, null, 2) + '\n')
}

export function getBindings(): VaultBinding[] {
  return readBindings().bindings
}

export function addBinding(binding: VaultBinding): void {
  const store = readBindings()
  const idx = store.bindings.findIndex(
    b => b.vaultSecretId === binding.vaultSecretId && b.envVar === binding.envVar,
  )
  if (idx >= 0) {
    store.bindings[idx] = binding
  } else {
    store.bindings.push(binding)
  }
  writeBindings(store)
}

export function removeBinding(vaultSecretId: string, envVar: string): boolean {
  const store = readBindings()
  const before = store.bindings.length
  store.bindings = store.bindings.filter(
    b => !(b.vaultSecretId === vaultSecretId && b.envVar === envVar),
  )
  if (store.bindings.length === before) return false
  writeBindings(store)
  return true
}

export function removeBindingsForSecret(vaultSecretId: string): void {
  const store = readBindings()
  store.bindings = store.bindings.filter(b => b.vaultSecretId !== vaultSecretId)
  writeBindings(store)
}

export function collectAllMcpFilePaths(): Array<{ path: string, label: string }> {
  const paths: Array<{ path: string, label: string }> = []
  const projectMcp = join(PROJECT_ROOT, '.mcp.json')
  if (existsSync(projectMcp)) paths.push({ path: projectMcp, label: 'project' })
  const userMcp = join(homedir(), '.claude.json')
  if (existsSync(userMcp)) paths.push({ path: userMcp, label: 'user' })

  for (const agentName of listAgentNames()) {
    const agentMcp = join(AGENTS_BASE_DIR, agentName, '.mcp.json')
    if (existsSync(agentMcp)) paths.push({ path: agentMcp, label: `agent:${agentName}` })
    const projectsDir = join(AGENTS_BASE_DIR, agentName, 'projects')
    if (existsSync(projectsDir)) {
      try {
        for (const proj of readdirSync(projectsDir)) {
          if (!statSync(join(projectsDir, proj)).isDirectory()) continue
          const projMcp = join(projectsDir, proj, '.mcp.json')
          if (existsSync(projMcp)) paths.push({ path: projMcp, label: `project:${agentName}/${proj}` })
        }
      } catch { /* ignore */ }
    }
  }
  for (const extPath of getExternalProjectPaths()) {
    const extMcp = join(extPath, '.mcp.json')
    if (existsSync(extMcp)) paths.push({ path: extMcp, label: `external:${basename(extPath)}` })
  }
  return paths
}

function maskValue(val: string): string {
  if (val.length <= 6) return '***'
  return val.slice(0, 3) + '...' + val.slice(-3)
}

function looksLikeSensitiveValue(val: string): boolean {
  if (!val || val.length < 8) return false
  for (const p of NON_SENSITIVE_VALUE_PATTERNS) {
    if (p.test(val)) return false
  }
  return true
}

function looksLikeSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(key))
}

export function scanMcpConfigs(): ScanFinding[] {
  const findings: ScanFinding[] = []
  const mcpFiles = collectAllMcpFilePaths()
  const existingSecrets = listSecrets()

  const vaultValues = new Map<string, string>()
  for (const s of existingSecrets) {
    const val = getSecret(s.id)
    if (val) vaultValues.set(val, s.id)
  }

  for (const { path: mcpPath } of mcpFiles) {
    try {
      const parsed = JSON.parse(readFileOr(mcpPath, '{}'))
      const servers = parsed.mcpServers || {}
      for (const [serverName, cfg] of Object.entries(servers) as Array<[string, any]>) {
        const env = cfg?.env || {}
        for (const [envVar, envVal] of Object.entries(env) as Array<[string, string]>) {
          if (!looksLikeSensitiveKey(envVar)) continue
          if (!looksLikeSensitiveValue(String(envVal))) continue

          const existingVaultId = vaultValues.get(String(envVal))
          findings.push({
            mcpFilePath: mcpPath,
            serverName,
            envVar,
            maskedValue: maskValue(String(envVal)),
            suggestedVaultId: `${serverName}-${envVar}`,
            alreadyInVault: !!existingVaultId,
            existingVaultId,
          })
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return findings
}

export function syncSecret(vaultSecretId: string): SyncResult {
  const bindings = getBindings().filter(b => b.vaultSecretId === vaultSecretId)
  if (bindings.length === 0) return { updated: 0, errors: [] }

  const value = getSecret(vaultSecretId)
  if (value === null) return { updated: 0, errors: [`Vault secret "${vaultSecretId}" not found`] }

  let updated = 0
  const errors: string[] = []

  for (const binding of bindings) {
    for (const target of binding.targets) {
      try {
        const content = JSON.parse(readFileOr(target.mcpFilePath, '{}'))
        if (!content.mcpServers?.[target.serverName]) {
          errors.push(`Server "${target.serverName}" not found in ${target.mcpFilePath}`)
          continue
        }
        if (!content.mcpServers[target.serverName].env) {
          content.mcpServers[target.serverName].env = {}
        }
        content.mcpServers[target.serverName].env[binding.envVar] = value
        atomicWriteFileSync(target.mcpFilePath, JSON.stringify(content, null, 2))
        updated++
      } catch (err: any) {
        errors.push(`Failed to update ${target.mcpFilePath}: ${err.message}`)
      }
    }
  }

  if (updated > 0) logger.info({ vaultSecretId, updated }, 'Vault secret synced to .mcp.json files')
  return { updated, errors }
}

export function syncAllBindings(): SyncResult {
  const allBindings = getBindings()
  const secretIds = new Set(allBindings.map(b => b.vaultSecretId))
  let totalUpdated = 0
  const allErrors: string[] = []

  for (const id of secretIds) {
    const result = syncSecret(id)
    totalUpdated += result.updated
    allErrors.push(...result.errors)
  }
  return { updated: totalUpdated, errors: allErrors }
}
