// Fleet export / import.
//
// Builds a single portable JSON snapshot of fleet content (agents, skills,
// scheduled tasks, DB tables, dashboard settings, optional vault) so it can
// be loaded into a freshly-installed, clean-git dashboard on another machine.
//
// Source code, build artefacts, OAuth tokens, and machine-specific paths are
// NOT included -- those come from a normal `npm ci && npm run build` install.

import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync,
} from 'node:fs'
import { join, extname } from 'node:path'
import { homedir, hostname } from 'node:os'
import {
  randomBytes, createCipheriv, createDecipheriv, scryptSync,
} from 'node:crypto'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID, BOT_NAME, BRAND_NAME, OWNER_NAME, CHANNEL_PROVIDER } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { updateEnvFile } from '../env.js'
import { AGENTS_BASE_DIR, listAgentNames } from './agent-config.js'
import { safeJoin } from './sanitize.js'
import { SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { getBindings } from './vault-bindings.js'
import { getDb, backfillEmbeddings } from '../db.js'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Schema version -- bump when the JSON shape changes incompatibly.
// ---------------------------------------------------------------------------
export const FLEET_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// UserFacingError -- user-fixable condition; route maps to 400 (not 500).
// ---------------------------------------------------------------------------
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

// ---------------------------------------------------------------------------
// Name validation (used to guard all import-side path joins -- B1)
// ---------------------------------------------------------------------------
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

function assertSafeName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
    throw new Error(`Érvénytelen ${field} érték: "${String(value).slice(0, 60)}" -- csak [a-z0-9_-] megengedett.`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetJson {
  schemaVersion: 1
  exportedAt: string
  sourceHost: string
  mainAgent?: MainAgentExport
  agents: AgentExport[]
  skills: SkillExport[]
  scheduledTasks: ScheduledTaskExport[]
  memories: MemoryRow[]      // ALL agent_ids (main + sub-agents)
  dailyLogs: DailyLogRow[]   // ALL agent_ids
  kanban: KanbanExport
  ideaBox: IdeaBoxExport
  dashboardSettings: DashboardSettingsExport
  vault?: VaultExport
}

// Identity set transferred with the fleet so the target becomes an exact copy of the source.
export interface FleetIdentity {
  MAIN_AGENT_ID: string
  BOT_NAME: string
  BRAND_NAME: string
  OWNER_NAME: string
  CHANNEL_PROVIDER: string
}

// Main agent lives at PROJECT_ROOT (not under agents/), so it needs its own export section.
export interface MainAgentExport {
  agentId: string  // source MAIN_AGENT_ID -- kept for backward-compat; identity supersedes this
  identity?: FleetIdentity  // full identity set; absent in exports from older versions
  claudeMd: string
  soulMd: string
  config: Record<string, unknown>
  mcp: Record<string, unknown>
  settings: Record<string, unknown>
  channelsAccess: Record<string, unknown>  // provider -> access.json (pairing config, NOT bot token)
}

export interface AgentExport {
  name: string
  config: Record<string, unknown>
  claudeMd: string
  soulMd: string
  mcp: Record<string, unknown>
  settings: Record<string, unknown>
  channelsAccess: Record<string, unknown>
  avatar: string | null  // base64
  avatarExt: string      // 'png' or 'jpg'
  agentSkills: SkillExport[]
}

export interface SkillExport {
  name: string
  skillMd: string
}

export interface ScheduledTaskExport {
  dirName: string
  skillMd: string
  config: Record<string, unknown>
}

export interface KanbanExport {
  cards: Record<string, unknown>[]
  comments: Record<string, unknown>[]
  cardEvents: Record<string, unknown>[]
  labels: Record<string, unknown>[]
  cardLabels: Record<string, unknown>[]
}

export interface IdeaBoxExport {
  ideas: Record<string, unknown>[]
  comments: Record<string, unknown>[]
  statusLog: Record<string, unknown>[]
}

export interface DashboardSettingsExport {
  autonomy: Record<string, unknown>
  autoRestart: Record<string, unknown>
  agentsDesired: Record<string, unknown>
  norbertPersonal: Record<string, unknown>
}

export interface MemoryRow {
  agent_id: string
  content: string
  sector: string
  salience: number
  created_at: number
  accessed_at: number
  category: string
  auto_generated: number
  keywords: string | null
}

export interface DailyLogRow {
  agent_id: string
  date: string
  content: string
  created_at: number
}

export interface VaultExport {
  vaultKey: string  // raw base64 content of .vault-key (safe: whole JSON is encrypted when password given)
  entries: Record<string, unknown>[]
  bindings: Record<string, unknown>[]
  // NOTE: channel .env (bot tokens) deliberately NOT exported -- re-pair model:
  // a Telegram bot accepts only one active poller; exporting+auto-activating tokens
  // would cause 409 errors and silent messages on the source. Target must re-pair manually.
}

export interface DiffReport {
  dryRun: true
  wouldCreate: {
    mainAgent: boolean
    agents: string[]
    globalSkills: number
    scheduledTasks: number
    memories: number
    kanbanCards: number
    kanbanComments: number
    labels: number
    dailyLogs: number
    ideaBox: number
  }
  wouldOverwrite: {
    agents: string[]  // existing sub-agent names that would be overwritten
    mainAgent: boolean
  }
  warnings: string[]
  errors: string[]
}

export interface ImportResult {
  ok: true
  imported: {
    mainAgent: boolean
    agents: string[]
    globalSkills: number
    scheduledTasks: number
    memories: number
    kanbanCards: number
    labels: number
    dailyLogs: number
    ideaBox: number
  }
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Crypto helpers -- M7: versioned packed blob, scrypt N=2^17
// ---------------------------------------------------------------------------

const KDF_VERSION = 1
const KDF_N_LOG2 = 17   // N = 2^17 = 131072 (appropriate for user-chosen password on portable file)
const KDF_R = 8
const KDF_P = 1
const KDF_KEYLEN = 32
const KDF_SALT_LEN = 32
const GCM_IV_LEN = 12   // GCM standard is 12 bytes
const GCM_TAG_LEN = 16

// Packed format: [version:1][N_log2:1][r:1][p:1][salt:32][iv:12][tag:16][ciphertext:...]
function encryptWithPassword(plaintext: string, password: string): string {
  const salt = randomBytes(KDF_SALT_LEN)
  const key = scryptSync(password, salt, KDF_KEYLEN, { N: 2 ** KDF_N_LOG2, r: KDF_R, p: KDF_P, maxmem: 256 * 1024 * 1024 })
  const iv = randomBytes(GCM_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.from([KDF_VERSION, KDF_N_LOG2, KDF_R, KDF_P])
  return Buffer.concat([header, salt, iv, tag, enc]).toString('base64')
}

// Exported for unit testing (crypto round-trip verification)
export function _encryptForTest(plaintext: string, password: string): string {
  return encryptWithPassword(plaintext, password)
}
export function _decryptForTest(packed: string, password: string): string {
  return decryptWithPassword(packed, password)
}

function decryptWithPassword(packed: string, password: string): string {
  const buf = Buffer.from(packed, 'base64')
  const MIN_PACKED_LEN = 4 + KDF_SALT_LEN + GCM_IV_LEN + GCM_TAG_LEN
  if (buf.length < MIN_PACKED_LEN) {
    throw new Error(`Érvénytelen titkosított blob: várt legalább ${MIN_PACKED_LEN} byte, kapott ${buf.length}.`)
  }
  // version byte (offset 0) reserved for future format changes; currently always 1
  const nLog2 = buf[1]
  const r = buf[2]
  const p = buf[3]
  const off = 4
  const salt = buf.subarray(off, off + KDF_SALT_LEN)
  const iv = buf.subarray(off + KDF_SALT_LEN, off + KDF_SALT_LEN + GCM_IV_LEN)
  const tag = buf.subarray(off + KDF_SALT_LEN + GCM_IV_LEN, off + KDF_SALT_LEN + GCM_IV_LEN + GCM_TAG_LEN)
  const ciphertext = buf.subarray(off + KDF_SALT_LEN + GCM_IV_LEN + GCM_TAG_LEN)
  const key = scryptSync(password, salt, KDF_KEYLEN, { N: 2 ** nLog2, r, p, maxmem: 256 * 1024 * 1024 })
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  // Buffer.concat avoids multi-byte UTF-8 split corruption at chunk boundary
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

export const MIN_VAULT_PASSWORD_LEN = 8

// ---------------------------------------------------------------------------
// Path normalization (H4: applied to the entire serialized FleetJson)
// ---------------------------------------------------------------------------

// Collision-resistant sentinels: namespaced so memory/skill content can't accidentally contain them
const PROJECT_ROOT_PLACEHOLDER = '{{FLEET:PROJECT_ROOT}}'
const HOME_PLACEHOLDER = '{{FLEET:HOME}}'

function normalizePaths(text: string): string {
  // Replace PROJECT_ROOT before HOME: on typical installs HOME is a prefix of PROJECT_ROOT.
  return text
    .replaceAll(PROJECT_ROOT, PROJECT_ROOT_PLACEHOLDER)
    .replaceAll(homedir(), HOME_PLACEHOLDER)
}

function denormalizePaths(text: string): string {
  return text
    .replaceAll(PROJECT_ROOT_PLACEHOLDER, PROJECT_ROOT)
    .replaceAll(HOME_PLACEHOLDER, homedir())
}

// ---------------------------------------------------------------------------
// .mcp.json placeholder handling (B2: scan env AND headers, entropy hard-fail)
// ---------------------------------------------------------------------------

// Patterns that suggest a value is NOT a secret (safe to export plaintext).
const NON_SECRET_VALUE_RE = [
  /^(true|false)$/i,
  /^https?:\/\//,
  /^\d+$/,
  /^\//,
  /^\$\{/,
  /^vault:/,
  /^\{\{VAULT:/,
  // Note: no /\s/ exemption -- "Bearer sk-live-..." contains whitespace but IS a secret
]

function looksLikeSecret(value: string): boolean {
  if (value.length < 16) return false
  for (const re of NON_SECRET_VALUE_RE) {
    if (re.test(value)) return false
  }
  return true
}

// Auth scheme prefixes to strip before entropy check on header values
const HEADER_AUTH_SCHEME_RE = /^(?:Bearer|Basic|Token|Digest)\s+/i
// Header keys that always carry secrets (unless already vault-bound)
const ALWAYS_SECRET_HEADER_KEY_RE = /^(authorization|x-api-key|x-auth-token|.*-token|.*-key)$/i
// Well-known non-secret header keys: content/transport metadata, never credentials
const NON_SECRET_HEADER_KEY_RE = /^(content-type|accept|accept-encoding|accept-language|content-length|user-agent|connection|host|origin|referer|cache-control|if-modified-since|if-none-match|pragma|transfer-encoding|upgrade)$/i
// Non-secret patterns for header values -- note: no URL exemption (https://user:cred@host IS a secret)
const NON_SECRET_HEADER_VALUE_RE = [
  /^(true|false)$/i,
  /^\d+$/,
  /^\//,
  /^\$\{/,
  /^vault:/,
  /^\{\{VAULT:/,
]

function looksLikeHeaderSecret(key: string, value: string): boolean {
  if (NON_SECRET_HEADER_KEY_RE.test(key)) return false
  if (ALWAYS_SECRET_HEADER_KEY_RE.test(key)) return true
  // Strip auth scheme prefix ("Bearer ", "Basic "…) then check the credential part
  const stripped = value.replace(HEADER_AUTH_SCHEME_RE, '')
  if (stripped.length < 16) return false
  for (const re of NON_SECRET_HEADER_VALUE_RE) {
    if (re.test(stripped)) return false
  }
  return true
}

// Build lookup: mcpFilePath -> serverName -> envVar -> vaultSecretId
function buildBindingLookup(): Map<string, Map<string, Map<string, string>>> {
  const lookup = new Map<string, Map<string, Map<string, string>>>()
  for (const binding of getBindings()) {
    for (const target of binding.targets) {
      if (!lookup.has(target.mcpFilePath)) lookup.set(target.mcpFilePath, new Map())
      const byServer = lookup.get(target.mcpFilePath)!
      if (!byServer.has(target.serverName)) byServer.set(target.serverName, new Map())
      byServer.get(target.serverName)!.set(binding.envVar, binding.vaultSecretId)
    }
  }
  return lookup
}

// Scan env AND headers for secrets; convert known vault refs to {{VAULT:id}};
// hard-fail on unbound high-entropy literals (B2).
function placeholderMcp(
  mcpObj: Record<string, unknown>,
  mcpFilePath: string,
  lookup: Map<string, Map<string, Map<string, string>>>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mcpObj)) as Record<string, unknown>
  const byServer = lookup.get(mcpFilePath)
  const servers = result.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (!servers) return result

  for (const [serverName, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as Record<string, unknown>
    const byEnv = byServer?.get(serverName)

    const blockingFields: string[] = []
    for (const field of ['env', 'headers'] as const) {
      const dict = c[field] as Record<string, string> | undefined
      if (!dict) continue
      for (const [key, val] of Object.entries(dict)) {
        if (typeof val !== 'string') continue
        if (val.startsWith('vault:')) {
          dict[key] = `{{VAULT:${val.slice(6)}}}`
        } else if (byEnv?.has(key)) {
          dict[key] = `{{VAULT:${byEnv.get(key)!}}}`
        } else {
          const isSecret = field === 'headers' ? looksLikeHeaderSecret(key, val) : looksLikeSecret(val)
          if (isSecret) {
            blockingFields.push(`mező="${field}", kulcs="${key}"`)
          }
        }
      }
    }

    // H1: also scan args (string[]) and url/command (string) for embedded secrets
    const args = c.args
    if (Array.isArray(args)) {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (typeof arg === 'string' && looksLikeSecret(arg)) {
          blockingFields.push(`mező="args[${i}]"`)
        }
      }
    }
    for (const fld of ['url', 'command'] as const) {
      const val = c[fld]
      if (typeof val === 'string' && looksLikeSecret(val)) {
        blockingFields.push(`mező="${fld}"`)
      }
    }

    if (blockingFields.length > 0) {
      throw new UserFacingError(
        `Titkosítatlan secret az .mcp.json-ban: szerver="${serverName}": ${blockingFields.join('; ')}. ` +
        `Kösd be a vault-ba a dashboard Vault oldalán, majd próbáld újra az exportot.`
      )
    }
  }
  return result
}

// Reverse: {{VAULT:<id>}} -> vault:<id> (vault-env-wrapper.sh resolves at runtime)
function deplaceholderMcp(mcpObj: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mcpObj)) as Record<string, unknown>
  const servers = result.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (!servers) return result
  for (const [, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const c = cfg as Record<string, unknown>
    for (const field of ['env', 'headers'] as const) {
      const dict = c[field] as Record<string, string> | undefined
      if (!dict) continue
      for (const [k, v] of Object.entries(dict)) {
        if (typeof v === 'string' && v.startsWith('{{VAULT:') && v.endsWith('}}')) {
          dict[k] = `vault:${v.slice(8, -2)}`
        }
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function safeReadJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return {} }
}

function safeReadText(path: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

function safeReadBase64(path: string): string | null {
  try { return readFileSync(path).toString('base64') } catch { return null }
}

function listSkillsInDir(dir: string): SkillExport[] {
  if (!existsSync(dir)) return []
  const skills: SkillExport[] = []
  for (const entry of readdirSync(dir)) {
    const skillMdPath = join(dir, entry, 'SKILL.md')
    if (existsSync(skillMdPath)) {
      skills.push({ name: entry, skillMd: safeReadText(skillMdPath) })
    }
  }
  return skills
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportChannelsAccess(channelsDir: string): Record<string, unknown> {
  const channelsAccess: Record<string, unknown> = {}
  if (existsSync(channelsDir)) {
    for (const provider of readdirSync(channelsDir)) {
      const accessPath = join(channelsDir, provider, 'access.json')
      if (existsSync(accessPath)) {
        channelsAccess[provider] = safeReadJson(accessPath)
      }
    }
  }
  return channelsAccess
}

// Main agent lives at PROJECT_ROOT -- exported separately since it's not under agents/.
function exportMainAgent(
  bindingLookup: Map<string, Map<string, Map<string, string>>>,
  withSecrets: boolean,
): MainAgentExport {
  const claudeDir = join(PROJECT_ROOT, '.claude')
  const mcpPath = join(PROJECT_ROOT, '.mcp.json')
  const settingsPath = join(claudeDir, 'settings.json')

  const rawMcp = safeReadJson(mcpPath)
  // withSecrets: whole JSON will be encrypted -- skip placeholder/hard-fail
  const mcp = withSecrets ? rawMcp : placeholderMcp(rawMcp, mcpPath, bindingLookup)

  const settingsRaw = safeReadText(settingsPath)
  const settings = settingsRaw ? JSON.parse(settingsRaw) as Record<string, unknown> : {}

  // M4: in plaintext export, hard-fail if settings.env contains secrets
  if (!withSecrets && typeof settings.env === 'object' && settings.env !== null) {
    for (const [key, val] of Object.entries(settings.env as Record<string, unknown>)) {
      if (typeof val === 'string' && looksLikeSecret(val)) {
        throw new UserFacingError(
          `Titkosítatlan secret a settings.json env blokkjában: kulcs="${key}". ` +
          `Adj meg vault jelszót az exporthoz, vagy távolítsd el a titkot a settings.json-ból.`
        )
      }
    }
  }

  // Main agent channel access lives at ~/.claude/channels/<provider>/access.json
  const channelsAccess = exportChannelsAccess(join(homedir(), '.claude', 'channels'))

  return {
    agentId: MAIN_AGENT_ID,
    identity: {
      MAIN_AGENT_ID,
      BOT_NAME,
      BRAND_NAME,
      OWNER_NAME,
      CHANNEL_PROVIDER,
    },
    claudeMd: safeReadText(join(PROJECT_ROOT, 'CLAUDE.md')),
    soulMd: safeReadText(join(PROJECT_ROOT, 'SOUL.md')),
    config: safeReadJson(join(PROJECT_ROOT, 'agent-config.json')),
    mcp,
    settings,
    channelsAccess,
  }
}

function exportAgent(
  name: string,
  bindingLookup: Map<string, Map<string, Map<string, string>>>,
  withSecrets: boolean,
): AgentExport {
  const dir = join(AGENTS_BASE_DIR, name)
  const claudeDir = join(dir, '.claude')
  const mcpPath = join(dir, '.mcp.json')
  const settingsPath = join(claudeDir, 'settings.json')

  const rawMcp = safeReadJson(mcpPath)
  // withSecrets: whole JSON will be encrypted -- skip placeholder/hard-fail
  const mcp = withSecrets ? rawMcp : placeholderMcp(rawMcp, mcpPath, bindingLookup)

  const settingsRaw = safeReadText(settingsPath)
  const settings = settingsRaw ? JSON.parse(settingsRaw) as Record<string, unknown> : {}

  // M4: in plaintext export, hard-fail if settings.env contains secrets
  if (!withSecrets && typeof settings.env === 'object' && settings.env !== null) {
    for (const [key, val] of Object.entries(settings.env as Record<string, unknown>)) {
      if (typeof val === 'string' && looksLikeSecret(val)) {
        throw new UserFacingError(
          `Titkosítatlan secret az agent "${name}" settings.json env blokkjában: kulcs="${key}". ` +
          `Adj meg vault jelszót az exporthoz, vagy távolítsd el a titkot a settings.json-ból.`
        )
      }
    }
  }

  // channels/access.json per provider (not .env -- vault-gated)
  const channelsAccess = exportChannelsAccess(join(claudeDir, 'channels'))

  // avatar -- preserve actual extension
  let avatar: string | null = null
  let avatarExt = 'png'
  const pngPath = join(dir, 'avatar.png')
  const jpgPath = join(dir, 'avatar.jpg')
  if (existsSync(pngPath)) {
    avatar = safeReadBase64(pngPath)
    avatarExt = 'png'
  } else if (existsSync(jpgPath)) {
    avatar = safeReadBase64(jpgPath)
    avatarExt = 'jpg'
  }

  return {
    name,
    config: safeReadJson(join(dir, 'agent-config.json')),
    claudeMd: safeReadText(join(dir, 'CLAUDE.md')),
    soulMd: safeReadText(join(dir, 'SOUL.md')),
    mcp,
    settings,
    channelsAccess,
    avatar,
    avatarExt,
    agentSkills: listSkillsInDir(join(claudeDir, 'skills')),
  }
}

function exportScheduledTasks(): ScheduledTaskExport[] {
  if (!existsSync(SCHEDULED_TASKS_DIR)) return []
  const result: ScheduledTaskExport[] = []
  for (const dirName of readdirSync(SCHEDULED_TASKS_DIR)) {
    const dir = join(SCHEDULED_TASKS_DIR, dirName)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    const skillMd = safeReadText(join(dir, 'SKILL.md'))
    const configRaw = safeReadJson(join(dir, 'task-config.json'))
    result.push({ dirName, skillMd, config: { ...configRaw, enabled: false } })
  }
  return result
}

function exportDashboardSettings(): DashboardSettingsExport {
  const read = (name: string) => safeReadJson(join(STORE_DIR, name))
  return {
    autonomy: read('autonomy-config.json'),
    autoRestart: read('auto-restart.json'),
    agentsDesired: read('agents-desired.json'),
    norbertPersonal: read('norbert-personal.json'),
  }
}

function exportVault(): VaultExport | null {
  const vaultKeyPath = join(STORE_DIR, '.vault-key')
  const vaultKeyMigratedPath = join(STORE_DIR, '.vault-key.migrated')
  const vaultPath = join(STORE_DIR, 'vault.json')
  const bindingsPath = join(STORE_DIR, 'vault-bindings.json')

  if (!existsSync(vaultKeyPath)) {
    // macOS Keychain migration -- vault-key.migrated means key is in Keychain
    if (existsSync(vaultKeyMigratedPath)) {
      throw new Error(
        'A vault kulcs macOS Keychain-be lett migrálva (.vault-key.migrated megtalálható). ' +
        'A vault szekció exportja ebben a konfigurációban nem támogatott -- adj meg vault jelszót.'
      )
    }
    return null
  }

  // Raw export: the entire FleetJson will be encrypted, so vault data is safe as plaintext here.
  const vaultKey = readFileSync(vaultKeyPath, 'utf-8').trim()
  const vaultStore = safeReadJson(vaultPath)
  const entries = (vaultStore.entries as Record<string, unknown>[]) ?? []
  const bindingsStore = safeReadJson(bindingsPath)
  const bindings = (bindingsStore.bindings as Record<string, unknown>[]) ?? []

  // Channel .env (bot tokens) are intentionally NOT exported -- see re-pair model comment in VaultExport.
  return { vaultKey, entries, bindings }
}

// Encrypted export wrapper: {"enc":1,"blob":"<base64-of-encrypted-fleet-json>"}
// The enc field signals the import side to decrypt before parsing.
export const ENCRYPTED_FLEET_VERSION = 1

export type ExportedFleet = { data: string; exportedAt: string }

export function exportFleet(options: { vaultPassword?: string } = {}): ExportedFleet {
  if (options.vaultPassword !== undefined && options.vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
    throw new Error(`A vault jelszó legalább ${MIN_VAULT_PASSWORD_LEN} karakter kell legyen.`)
  }

  const withSecrets = !!options.vaultPassword
  const db = getDb()
  const bindingLookup = withSecrets ? new Map() : buildBindingLookup()

  const mainAgent = exportMainAgent(bindingLookup, withSecrets)
  const agents = listAgentNames().map(name => exportAgent(name, bindingLookup, withSecrets))
  const skills = listSkillsInDir(join(homedir(), '.claude', 'skills'))
  const scheduledTasks = exportScheduledTasks()

  // Export ALL memories and daily_logs across every agent_id
  const memories = db.prepare(
    `SELECT agent_id, content, sector, salience, created_at, accessed_at,
            category, auto_generated, keywords
     FROM memories ORDER BY agent_id ASC, created_at ASC`
  ).all() as MemoryRow[]

  const dailyLogs = db.prepare(
    'SELECT agent_id, date, content, created_at FROM daily_logs ORDER BY agent_id ASC, date ASC'
  ).all() as DailyLogRow[]

  const kanban: KanbanExport = {
    cards: db.prepare('SELECT * FROM kanban_cards').all() as Record<string, unknown>[],
    comments: db.prepare('SELECT * FROM kanban_comments').all() as Record<string, unknown>[],
    cardEvents: db.prepare('SELECT * FROM kanban_card_events').all() as Record<string, unknown>[],
    labels: db.prepare('SELECT * FROM labels').all() as Record<string, unknown>[],
    cardLabels: db.prepare('SELECT * FROM kanban_card_labels').all() as Record<string, unknown>[],
  }

  const ideaBox: IdeaBoxExport = {
    ideas: db.prepare('SELECT * FROM idea_box').all() as Record<string, unknown>[],
    comments: db.prepare('SELECT * FROM idea_comments').all() as Record<string, unknown>[],
    statusLog: db.prepare('SELECT * FROM idea_status_log').all() as Record<string, unknown>[],
  }

  // Vault section is only included in encrypted exports (whole-JSON encryption makes it safe)
  const vault = withSecrets ? exportVault() : undefined

  const fleet: FleetJson = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceHost: hostname(),
    mainAgent,
    agents,
    skills,
    scheduledTasks,
    memories,
    dailyLogs,
    kanban,
    ideaBox,
    dashboardSettings: exportDashboardSettings(),
    ...(vault ? { vault } : {}),
  }

  // Normalize ALL absolute paths in the entire JSON in one pass
  const normalized = normalizePaths(JSON.stringify(fleet))

  if (withSecrets) {
    // Encrypt the entire JSON -- vault secrets, MCP tokens, settings.env all protected as a unit
    const blob = encryptWithPassword(normalized, options.vaultPassword!)
    const data = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })
    return { data, exportedAt: fleet.exportedAt }
  }

  return { data: normalized, exportedAt: fleet.exportedAt }
}

// ---------------------------------------------------------------------------
// Import -- validate, dry-run, and apply
// ---------------------------------------------------------------------------

function validateSchema(fleet: unknown): string[] {
  const errors: string[] = []
  if (!fleet || typeof fleet !== 'object') {
    errors.push('Érvénytelen JSON: a gyökér nem objektum.')
    return errors
  }
  const f = fleet as Record<string, unknown>
  if (f.schemaVersion === undefined || f.schemaVersion === null) {
    errors.push('schemaVersion hiányzik -- az export nem kompatibilis vagy pre-v1 build hozta létre.')
    return errors
  }
  if (f.schemaVersion !== FLEET_SCHEMA_VERSION) {
    const v = f.schemaVersion
    errors.push(
      `Az export schema v${v}, a telepített dashboard v${FLEET_SCHEMA_VERSION}-t támogat. ` +
      (Number(v) > FLEET_SCHEMA_VERSION
        ? 'Frissítsd a dashboardot az import előtt.'
        : 'Az export túl régi.')
    )
    return errors
  }
  if (!Array.isArray(f.agents)) errors.push('agents mező hiányzik vagy nem tömb.')
  return errors
}

// B1: validate all untrusted names before any file operation
function validateNames(fleet: FleetJson): string[] {
  const errors: string[] = []

  // mainAgent channel providers (written to ~/.claude/channels/<provider>/)
  for (const provider of Object.keys(fleet.mainAgent?.channelsAccess ?? {})) {
    if (!SAFE_NAME_RE.test(provider)) {
      errors.push(`Érvénytelen mainAgent channel provider: "${provider.slice(0, 60)}"`)
    }
  }

  for (const agent of fleet.agents ?? []) {
    if (!SAFE_NAME_RE.test(String(agent.name ?? ''))) {
      errors.push(`Érvénytelen agent.name: "${String(agent.name).slice(0, 60)}"`)
    }
    // B1: avatarExt defense-in-depth guard (primary enforcement in writeAgentFiles)
    if (agent.avatar && agent.avatarExt !== undefined &&
        !/^(png|jpe?g|webp)$/i.test(String(agent.avatarExt))) {
      errors.push(`Érvénytelen avatarExt (agent ${agent.name}): "${String(agent.avatarExt).slice(0, 20)}"`)
    }
    for (const skill of agent.agentSkills ?? []) {
      if (!SAFE_NAME_RE.test(String(skill.name ?? ''))) {
        errors.push(`Érvénytelen skill.name (agent ${agent.name}): "${String(skill.name).slice(0, 60)}"`)
      }
    }
    for (const provider of Object.keys(agent.channelsAccess ?? {})) {
      if (!SAFE_NAME_RE.test(provider)) {
        errors.push(`Érvénytelen channel provider (agent ${agent.name}): "${provider.slice(0, 60)}"`)
      }
    }
  }
  for (const skill of fleet.skills ?? []) {
    if (!SAFE_NAME_RE.test(String(skill.name ?? ''))) {
      errors.push(`Érvénytelen global skill.name: "${String(skill.name).slice(0, 60)}"`)
    }
  }
  for (const task of fleet.scheduledTasks ?? []) {
    if (!SAFE_NAME_RE.test(String(task.dirName ?? ''))) {
      errors.push(`Érvénytelen scheduledTask.dirName: "${String(task.dirName).slice(0, 60)}"`)
    }
  }
  return errors
}

function buildDiffReport(fleet: FleetJson): DiffReport {
  const db = getDb()
  const warnings: string[] = []

  const existingAgents = new Set(listAgentNames())
  const newAgents = (fleet.agents ?? []).map(a => a.name).filter(n => !existingAgents.has(n))

  let newMemories = 0
  for (const mem of fleet.memories ?? []) {
    if (!db.prepare('SELECT 1 FROM memories WHERE agent_id = ? AND content = ?').get(mem.agent_id, mem.content)) {
      newMemories++
    }
  }

  let newCards = 0
  for (const card of fleet.kanban?.cards ?? []) {
    if (!db.prepare('SELECT 1 FROM kanban_cards WHERE id = ?').get((card as any).id)) newCards++
  }

  let newLabels = 0
  for (const label of fleet.kanban?.labels ?? []) {
    if (!db.prepare('SELECT 1 FROM labels WHERE id = ?').get((label as any).id)) newLabels++
  }

  let newDailyLogs = 0
  for (const log of fleet.dailyLogs ?? []) {
    if (!db.prepare('SELECT 1 FROM daily_logs WHERE agent_id = ? AND date = ? AND content = ?').get(log.agent_id, log.date, log.content)) {
      newDailyLogs++
    }
  }

  let newComments = 0
  for (const c of fleet.kanban?.comments ?? []) {
    if (!db.prepare('SELECT 1 FROM kanban_comments WHERE card_id = ? AND content = ?')
      .get((c as any).card_id, (c as any).content)) newComments++
  }

  if (!fleet.vault) {
    warnings.push('vault szekció hiányzik -- az MCP szerverek token nélkül indulnak el, manuális re-auth szükséges.')
  }

  // H3: track which existing agents and main agent would be overwritten
  const existingAgentsToOverwrite = (fleet.agents ?? []).map(a => a.name).filter(n => existingAgents.has(n))
  const mainAgentOverwrite = !!fleet.mainAgent && existsSync(join(PROJECT_ROOT, 'CLAUDE.md'))

  // Channels: always warn -- bot tokens are not exported (re-pair model)
  const hasChannels = Object.keys(fleet.mainAgent?.channelsAccess ?? {}).length > 0 ||
    (fleet.agents ?? []).some(a => Object.keys(a.channelsAccess ?? {}).length > 0)
  if (hasChannels) {
    warnings.push('Csatornák: újra-párosítás szükséges a célgépen (bot token újboli megadása).')
  }

  // Identity takeover preview
  const drySourceId = fleet.mainAgent?.identity?.MAIN_AGENT_ID ?? fleet.mainAgent?.agentId
  if (drySourceId && typeof drySourceId === 'string') {
    warnings.push(
      `Fő-agent identitás átvéve: ${drySourceId}. Apply után újraindítás szükséges hogy a dashboard ${drySourceId}-ként induljon.`
    )
  }

  return {
    dryRun: true,
    wouldCreate: {
      mainAgent: !!fleet.mainAgent,
      agents: newAgents,
      globalSkills: (fleet.skills ?? []).length,
      scheduledTasks: (fleet.scheduledTasks ?? []).length,
      memories: newMemories,
      kanbanCards: newCards,
      kanbanComments: newComments,
      labels: newLabels,
      dailyLogs: newDailyLogs,
      ideaBox: (fleet.ideaBox?.ideas ?? []).length,
    },
    wouldOverwrite: {
      agents: existingAgentsToOverwrite,
      mainAgent: mainAgentOverwrite,
    },
    warnings,
    errors: [],
  }
}

// ---------------------------------------------------------------------------
// Apply helpers -- tracked writes for partial cleanup (H3)
// ---------------------------------------------------------------------------

interface WriteEntry {
  path: string
  preexisted: boolean
}

interface WriteTracker {
  files: WriteEntry[]
  dirs: string[]
}

function trackedMkdir(path: string, tracker: WriteTracker): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
    tracker.dirs.push(path)
  }
}

function trackedWrite(path: string, content: string | Buffer, tracker: WriteTracker, opts?: { mode?: number }): void {
  const preexisted = existsSync(path)
  atomicWriteFileSync(path, content as string, opts)
  tracker.files.push({ path, preexisted })
}

function cleanupTracked(tracker: WriteTracker): void {
  // Only delete files that did not exist before the import started; pre-existing overwritten files
  // cannot be restored (no backup), so we leave them rather than delete them (H3).
  for (const { path, preexisted } of tracker.files) {
    if (!preexisted) {
      try { unlinkSync(path) } catch { /* best effort */ }
    }
  }
  // Remove dirs in reverse order (deepest first), only if empty
  for (const d of [...tracker.dirs].reverse()) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function writeMainAgentFiles(ma: MainAgentExport, tracker: WriteTracker): void {
  const claudeDir = join(PROJECT_ROOT, '.claude')
  trackedMkdir(claudeDir, tracker)

  if (ma.claudeMd) trackedWrite(join(PROJECT_ROOT, 'CLAUDE.md'), ma.claudeMd, tracker)
  if (ma.soulMd) trackedWrite(join(PROJECT_ROOT, 'SOUL.md'), ma.soulMd, tracker)
  if (ma.config && Object.keys(ma.config).length)
    trackedWrite(join(PROJECT_ROOT, 'agent-config.json'), JSON.stringify(ma.config, null, 2), tracker)
  trackedWrite(join(PROJECT_ROOT, '.mcp.json'), JSON.stringify(deplaceholderMcp(ma.mcp), null, 2), tracker)
  trackedWrite(join(claudeDir, 'settings.json'), JSON.stringify(ma.settings, null, 2), tracker)

  // Main agent channel access: ~/.claude/channels/<provider>/access.json
  // B1: provider names validated by validateNames() before this is called
  const channelsBase = join(homedir(), '.claude', 'channels')
  for (const [provider, access] of Object.entries(ma.channelsAccess ?? {})) {
    const provDir = safeJoin(channelsBase, provider)
    trackedMkdir(provDir, tracker)
    trackedWrite(join(provDir, 'access.json'), JSON.stringify(access, null, 2), tracker)
  }
}

function writeAgentFiles(agent: AgentExport, tracker: WriteTracker): void {
  // B1: names already validated by validateNames() before this is called
  const dir = safeJoin(AGENTS_BASE_DIR, agent.name)
  const claudeDir = safeJoin(dir, '.claude')
  trackedMkdir(claudeDir, tracker)

  trackedWrite(join(dir, 'agent-config.json'), JSON.stringify(agent.config, null, 2), tracker)
  if (agent.claudeMd) trackedWrite(join(dir, 'CLAUDE.md'), agent.claudeMd, tracker)
  if (agent.soulMd) trackedWrite(join(dir, 'SOUL.md'), agent.soulMd, tracker)

  // .mcp.json: de-placeholder vault refs (path denormalization happens at fleet level)
  trackedWrite(join(dir, '.mcp.json'), JSON.stringify(deplaceholderMcp(agent.mcp), null, 2), tracker)

  trackedWrite(join(claudeDir, 'settings.json'), JSON.stringify(agent.settings, null, 2), tracker)

  for (const [provider, access] of Object.entries(agent.channelsAccess ?? {})) {
    const provDir = safeJoin(claudeDir, 'channels', provider)
    trackedMkdir(provDir, tracker)
    trackedWrite(join(provDir, 'access.json'), JSON.stringify(access, null, 2), tracker)
  }

  if (agent.avatar) {
    // B1: whitelist extension to prevent path traversal via malicious avatarExt
    const ext = /^(png|jpe?g|webp)$/i.test(String(agent.avatarExt || '')) ? String(agent.avatarExt) : 'png'
    trackedWrite(safeJoin(dir, `avatar.${ext}`), Buffer.from(agent.avatar, 'base64'), tracker)
  }

  for (const skill of agent.agentSkills ?? []) {
    const skillDir = safeJoin(claudeDir, 'skills', skill.name)
    trackedMkdir(skillDir, tracker)
    trackedWrite(join(skillDir, 'SKILL.md'), skill.skillMd, tracker)
  }
}

function importVaultSection(vault: VaultExport, tracker: WriteTracker): void {
  // vault.vaultKey is plaintext -- the caller already decrypted the whole JSON with the user password
  trackedWrite(join(STORE_DIR, '.vault-key'), vault.vaultKey, tracker, { mode: 0o600 })
  trackedWrite(join(STORE_DIR, 'vault.json'), JSON.stringify({ entries: vault.entries }, null, 2), tracker, { mode: 0o600 })
  trackedWrite(join(STORE_DIR, 'vault-bindings.json'), JSON.stringify({ bindings: vault.bindings }, null, 2), tracker)
  // Channel .env (bot tokens) are intentionally NOT imported -- target must re-pair channels manually.
}

const EMPTY_DIFF: DiffReport = {
  dryRun: true,
  wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
  wouldOverwrite: { agents: [], mainAgent: false },
  warnings: [],
  errors: [],
}

export function importFleet(
  rawBody: string,
  options: { vaultPassword?: string; apply: boolean },
): DiffReport | ImportResult {
  // Auto-detect encrypted export: {"enc":1,"blob":"..."}
  // H2/M2: decrypt FIRST, before any file writes or DB commits (fail-fast on wrong password)
  let jsonBody: string
  try {
    const parsed = JSON.parse(rawBody)
    if (parsed && typeof parsed === 'object' && parsed.enc === ENCRYPTED_FLEET_VERSION && typeof parsed.blob === 'string') {
      // Encrypted fleet -- password required
      if (!options.vaultPassword) {
        return { ...EMPTY_DIFF, errors: ['A fájl titkosítva van -- add meg a vault jelszót az importhoz.'] }
      }
      if (options.vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
        return { ...EMPTY_DIFF, errors: [`A vault jelszó legalább ${MIN_VAULT_PASSWORD_LEN} karakter kell legyen.`] }
      }
      try {
        jsonBody = decryptWithPassword(parsed.blob, options.vaultPassword)
      } catch {
        return { ...EMPTY_DIFF, errors: ['Helytelen vault jelszó -- a titkosított fájl nem dekódolható.'] }
      }
    } else {
      // Plaintext fleet JSON
      jsonBody = rawBody
    }
  } catch (err: any) {
    return { ...EMPTY_DIFF, errors: [`Érvénytelen JSON: ${err.message}`] }
  }

  // Denormalize paths in the entire JSON before any processing
  const fleet = JSON.parse(denormalizePaths(jsonBody)) as FleetJson

  const schemaErrors = validateSchema(fleet)
  if (schemaErrors.length > 0) {
    return { ...EMPTY_DIFF, errors: schemaErrors }
  }

  // B1: validate all names before dry-run or apply
  const nameErrors = validateNames(fleet)
  if (nameErrors.length > 0) {
    return { ...EMPTY_DIFF, errors: nameErrors }
  }

  if (!options.apply) {
    const report = buildDiffReport(fleet)
    // M1: vault present in export but no password at import -> warning (apply would skip vault)
    if (fleet.vault && !options.vaultPassword) {
      report.warnings.push('vault szekció jelen van, de nem adtál meg jelszót -- a vault-titkok kihagyásra kerülnek.')
    }
    return report
  }

  // -------------------------------------------------------------------------
  // Apply phase -- H3: track ALL writes, cleanup on any failure
  // -------------------------------------------------------------------------
  const db = getDb()
  const tracker: WriteTracker = { files: [], dirs: [] }
  const globalSkillsDir = join(homedir(), '.claude', 'skills')

  try {
    // 0. Main agent files (PROJECT_ROOT level -- main agent persona, settings, channel pairing)
    if (fleet.mainAgent) {
      writeMainAgentFiles(fleet.mainAgent, tracker)
    }

    // 1. Sub-agent files
    for (const agent of fleet.agents ?? []) {
      writeAgentFiles(agent, tracker)
    }

    // 2. Global skills
    trackedMkdir(globalSkillsDir, tracker)
    for (const skill of fleet.skills ?? []) {
      const skillDir = safeJoin(globalSkillsDir, skill.name)
      trackedMkdir(skillDir, tracker)
      trackedWrite(join(skillDir, 'SKILL.md'), skill.skillMd, tracker)
    }

    // 3. Scheduled tasks (all paused: enabled=false already set at export time)
    if (existsSync(SCHEDULED_TASKS_DIR) || fleet.scheduledTasks?.length) {
      trackedMkdir(SCHEDULED_TASKS_DIR, tracker)
    }
    for (const task of fleet.scheduledTasks ?? []) {
      const dir = safeJoin(SCHEDULED_TASKS_DIR, task.dirName)
      trackedMkdir(dir, tracker)
      if (task.skillMd) trackedWrite(join(dir, 'SKILL.md'), task.skillMd, tracker)
      trackedWrite(
        join(dir, 'task-config.json'),
        JSON.stringify({ ...task.config, enabled: false }, null, 2),
        tracker,
      )
    }

    // 4. Dashboard settings
    const s = fleet.dashboardSettings ?? {}
    if (s.autonomy && Object.keys(s.autonomy).length)
      trackedWrite(join(STORE_DIR, 'autonomy-config.json'), JSON.stringify(s.autonomy, null, 2), tracker)
    if (s.autoRestart && Object.keys(s.autoRestart).length)
      trackedWrite(join(STORE_DIR, 'auto-restart.json'), JSON.stringify(s.autoRestart, null, 2), tracker)
    if (s.agentsDesired && Object.keys(s.agentsDesired).length)
      trackedWrite(join(STORE_DIR, 'agents-desired.json'), JSON.stringify(s.agentsDesired, null, 2), tracker)
    if (s.norbertPersonal && Object.keys(s.norbertPersonal).length)
      trackedWrite(join(STORE_DIR, 'norbert-personal.json'), JSON.stringify(s.norbertPersonal, null, 2), tracker)

    // 5. DB -- single transaction (H3: before vault so vault is last and cleanup is cleaner)
    const importTx = db.transaction(() => {
      // labels first (FK dep for kanban_card_labels)
      // M3: skip rows with missing required fields to avoid SQLite constraint errors -> 500
      for (const label of fleet.kanban?.labels ?? []) {
        const l = label as any
        if (!l.id || !l.name) { logger.warn({ id: l.id }, 'Fleet import: skipping label with missing required fields'); continue }
        db.prepare('INSERT OR IGNORE INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)')
          .run(l.id, l.name, l.color, l.created_at)
      }

      for (const card of fleet.kanban?.cards ?? []) {
        const c = card as any
        if (!c.id || !c.title || !c.status || !c.priority || c.sort_order == null) {
          logger.warn({ id: c.id }, 'Fleet import: skipping kanban card with missing required fields'); continue
        }
        db.prepare(
          `INSERT OR IGNORE INTO kanban_cards
           (id, title, description, status, assignee, priority, project,
            due_date, sort_order, created_at, updated_at, archived_at, parent_id, dispatched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(c.id, c.title, c.description ?? null, c.status, c.assignee ?? null,
          c.priority, c.project ?? null, c.due_date ?? null, c.sort_order,
          c.created_at, c.updated_at, c.archived_at ?? null, c.parent_id ?? null, c.dispatched_at ?? null)
      }

      // kanban comments (idempotent: card_id + content)
      for (const comment of fleet.kanban?.comments ?? []) {
        const c = comment as any
        if (!c.card_id || !c.content) continue
        if (!db.prepare('SELECT 1 FROM kanban_comments WHERE card_id = ? AND content = ?').get(c.card_id, c.content)) {
          db.prepare('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)')
            .run(c.card_id, c.author, c.content, c.created_at)
        }
      }

      // kanban card events -- idempotent on (card_id, created_at, to_status)
      for (const ev of fleet.kanban?.cardEvents ?? []) {
        const e = ev as any
        if (!e.card_id || !e.to_status) continue
        if (!db.prepare('SELECT 1 FROM kanban_card_events WHERE card_id = ? AND created_at = ? AND to_status = ?')
          .get(e.card_id, e.created_at, e.to_status)) {
          db.prepare('INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(e.card_id, e.from_status ?? null, e.to_status, e.actor, e.created_at)
        }
      }

      for (const cl of fleet.kanban?.cardLabels ?? []) {
        const c = cl as any
        if (!c.card_id || !c.label_id) continue
        db.prepare('INSERT OR IGNORE INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)')
          .run(c.card_id, c.label_id, c.created_at)
      }

      // memories -- idempotent on (agent_id, content); covers ALL agent_ids
      // agent_id-k pontosan a forrásból kerülnek át (a cél átveszi a forrás főagent identitását)
      const now = Math.floor(Date.now() / 1000)
      for (const mem of fleet.memories ?? []) {
        if (!db.prepare('SELECT 1 FROM memories WHERE agent_id = ? AND content = ?').get(mem.agent_id, mem.content)) {
          db.prepare(
            `INSERT INTO memories
             (chat_id, topic_key, content, sector, salience, created_at, accessed_at,
              agent_id, category, auto_generated, keywords)
             VALUES ('', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(mem.content, mem.sector, mem.salience, mem.created_at, mem.accessed_at ?? now,
            mem.agent_id, mem.category, mem.auto_generated ?? 0, mem.keywords ?? null)
        }
      }

      // daily logs -- idempotent on (agent_id, date, content); multiple rows per date are preserved
      for (const log of fleet.dailyLogs ?? []) {
        if (!db.prepare('SELECT 1 FROM daily_logs WHERE agent_id = ? AND date = ? AND content = ?').get(log.agent_id, log.date, log.content)) {
          db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)')
            .run(log.agent_id, log.date, log.content, log.created_at)
        }
      }

      // idea_box -- idempotent on id
      for (const idea of fleet.ideaBox?.ideas ?? []) {
        const i = idea as any
        db.prepare(
          `INSERT OR IGNORE INTO idea_box
           (id, title, description, category, status, source, kanban_id, impact, effort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(i.id, i.title, i.description ?? null, i.category, i.status, i.source ?? '',
          i.kanban_id ?? null, i.impact ?? null, i.effort ?? null, i.created_at, i.updated_at)
      }

      // idea_comments -- M5: idempotent on (idea_id, created_at, content)
      for (const comment of fleet.ideaBox?.comments ?? []) {
        const c = comment as any
        if (!db.prepare('SELECT 1 FROM idea_comments WHERE idea_id = ? AND created_at = ? AND content = ?')
          .get(c.idea_id, c.created_at, c.content)) {
          db.prepare('INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)')
            .run(c.idea_id, c.author, c.content, c.created_at)
        }
      }

      // idea_status_log -- M5: idempotent on (idea_id, created_at, to_status)
      for (const log of fleet.ideaBox?.statusLog ?? []) {
        const l = log as any
        if (!db.prepare('SELECT 1 FROM idea_status_log WHERE idea_id = ? AND created_at = ? AND to_status = ?')
          .get(l.idea_id, l.created_at, l.to_status)) {
          db.prepare(
            'INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(l.idea_id, l.from_status ?? null, l.to_status, l.actor, l.note ?? null, l.created_at)
        }
      }

      // FTS rebuild after all memory inserts
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run()
    })

    importTx()

    // 6. Vault -- LAST: vault data is plaintext (decrypted at the top of importFleet)
    if (fleet.vault) {
      importVaultSection(fleet.vault, tracker)
    }

    // M3: fire-and-forget re-embed imported memories (embedding was stripped at export)
    backfillEmbeddings().catch(err => logger.warn({ err: err?.message }, 'Fleet import: embedding backfill failed'))

    // Identity takeover: write the source identity set into config-overrides.json so the
    // target install adopts the source persona (name, brand, owner) on next restart.
    // Preference: use identity object (full set) if present; fall back to agentId-only for
    // exports produced before the identity field was added.
    const applyWarnings: string[] = []
    const sourceIdentity = fleet.mainAgent?.identity
    const sourceAgentId = sourceIdentity?.MAIN_AGENT_ID ?? fleet.mainAgent?.agentId
    if (sourceAgentId && typeof sourceAgentId === 'string') {
      const overridesPath = join(STORE_DIR, 'config-overrides.json')
      let overrides: Record<string, unknown> = {}
      try {
        if (existsSync(overridesPath)) {
          overrides = JSON.parse(readFileSync(overridesPath, 'utf-8')) as Record<string, unknown>
        }
      } catch { /* start fresh if file is corrupt */ }
      if (sourceIdentity && typeof sourceIdentity === 'object') {
        // Full identity takeover: iterate all keys generically (no hardcoded names)
        for (const [key, val] of Object.entries(sourceIdentity)) {
          if (typeof val === 'string' && val.length > 0) {
            overrides[key] = val
          }
        }
      } else {
        // Backward-compat: old export without identity -- only set MAIN_AGENT_ID
        overrides['MAIN_AGENT_ID'] = sourceAgentId
      }
      atomicWriteFileSync(overridesPath, JSON.stringify(overrides, null, 2))

      // Mirror the identity into .env as well. The dashboard reads identity via
      // cfg() (config-overrides.json > .env), but shell-side launchers -- above
      // all scripts/channels.sh -- read MAIN_AGENT_ID / CHANNEL_PROVIDER
      // DIRECTLY from .env. Without this the main agent would launch under the
      // pre-import identity (`${old-id}-channels`) while the dashboard looks for
      // `${new-id}-channels` and reports the main agent as down.
      const envIdentity: Record<string, string> = {}
      if (sourceIdentity && typeof sourceIdentity === 'object') {
        for (const [key, val] of Object.entries(sourceIdentity)) {
          if (typeof val === 'string' && val.length > 0) envIdentity[key] = val
        }
      } else {
        envIdentity['MAIN_AGENT_ID'] = sourceAgentId
      }
      updateEnvFile(envIdentity)

      applyWarnings.push(
        `Fő-agent identitás átvéve: ${sourceAgentId}. Újraindítás kell hogy a dashboard ${sourceAgentId}-ként induljon.`
      )
    }

    logger.info({ agents: (fleet.agents ?? []).map(a => a.name) }, 'Fleet import completed')

    return {
      ok: true,
      imported: {
        mainAgent: !!fleet.mainAgent,
        agents: (fleet.agents ?? []).map(a => a.name),
        globalSkills: (fleet.skills ?? []).length,
        scheduledTasks: (fleet.scheduledTasks ?? []).length,
        memories: (fleet.memories ?? []).length,
        kanbanCards: (fleet.kanban?.cards ?? []).length,
        labels: (fleet.kanban?.labels ?? []).length,
        dailyLogs: (fleet.dailyLogs ?? []).length,
        ideaBox: (fleet.ideaBox?.ideas ?? []).length,
      },
      ...(applyWarnings.length > 0 ? { warnings: applyWarnings } : {}),
    }
  } catch (err: any) {
    cleanupTracked(tracker)
    logger.error({ err: err.message }, 'Fleet import failed, tracked writes cleaned up')
    throw err
  }
}
