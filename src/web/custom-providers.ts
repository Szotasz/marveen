// Only Anthropic-Messages-compatible endpoints are supported (/v1/messages).
// Pure OpenAI endpoints require a translation proxy (out of scope).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { HELPER_TASK_TYPES, type HelperTaskType, type HelperFallback } from './helper/types.js'

const PROVIDERS_PATH = join(PROJECT_ROOT, 'store', 'custom-providers.json')

export type AuthHeaderType = 'x-api-key' | 'Bearer' | 'none'

export interface CustomProviderDef {
  id: string
  label: string
  baseUrl: string
  authHeader: AuthHeaderType
  vaultKey: string | null
  // Local helper routing (docs/superpowers/specs/2026-10-26-local-helper-task-routing-design.md 4.3). All optional:
  // a provider file written before these fields loads unchanged, and a def
  // without them is saved byte-identical to before (the route copies them
  // only when present). Read only while HELPER_ENABLED=1 names this provider
  // in HELPER_PROVIDER_ID.
  /** Model tag for the helper's stateless decision call, e.g. "qwen3:14b". */
  helperModel?: string
  /** Which background task types this endpoint may handle. */
  taskTypes?: Partial<Record<HelperTaskType, boolean>>
  /** What a ticked task type does while this endpoint is down. */
  fallback?: Partial<Record<HelperTaskType, HelperFallback>>
  /** The Opus agent a fallback 'opus' goes to (default: the task's own agent). */
  fallbackAgent?: string
}

export { HELPER_TASK_TYPES, type HelperTaskType, type HelperFallback }

// Defaults for a provider on this machine: the first four types on (SPEC.md
// section 2). A remote endpoint defaults all-off -- the owner ticks it
// explicitly, because a ticked type sends card/message text to that host.
const LOCAL_DEFAULT_ON: ReadonlySet<HelperTaskType> = new Set(['watch', 'wake', 'quietHeartbeat', 'rotationDecision'])

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname
    return h === 'localhost' || h.startsWith('127.')
  } catch { return false }
}

export function defaultHelperTaskTypes(baseUrl: string): Record<HelperTaskType, boolean> {
  const local = isLocalBaseUrl(baseUrl)
  const out = {} as Record<HelperTaskType, boolean>
  for (const t of HELPER_TASK_TYPES) out[t] = local && LOCAL_DEFAULT_ON.has(t)
  return out
}

// Only the rotation decision falls through to an Opus agent by default; the
// others are skipped while the endpoint is down (SPEC.md section 2).
export function defaultHelperFallback(): Record<HelperTaskType, HelperFallback> {
  const out = {} as Record<HelperTaskType, HelperFallback>
  for (const t of HELPER_TASK_TYPES) out[t] = t === 'rotationDecision' ? 'opus' : 'skip'
  return out
}

/** The ticks in effect: the stored ones over the host-based defaults. */
export function effectiveTaskTypes(def: Pick<CustomProviderDef, 'baseUrl' | 'taskTypes'>): Record<HelperTaskType, boolean> {
  const out = defaultHelperTaskTypes(def.baseUrl)
  if (def.taskTypes) for (const t of HELPER_TASK_TYPES) if (typeof def.taskTypes[t] === 'boolean') out[t] = def.taskTypes[t] as boolean
  return out
}

export function effectiveFallback(def: Pick<CustomProviderDef, 'fallback'>): Record<HelperTaskType, HelperFallback> {
  const out = defaultHelperFallback()
  if (def.fallback) for (const t of HELPER_TASK_TYPES) {
    const v = def.fallback[t]
    if (v === 'skip' || v === 'opus') out[t] = v
  }
  return out
}

const HELPER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

// Validates the optional helper fields of a POST body. null = valid (or absent).
export function validateHelperFields(d: Record<string, unknown>): string | null {
  if (d.helperModel !== undefined && d.helperModel !== null && d.helperModel !== '') {
    if (typeof d.helperModel !== 'string' || !HELPER_MODEL_RE.test(d.helperModel.trim())) {
      return 'helperModel must be a model tag (letters, digits, . _ : / @ -; max 128)'
    }
  }
  for (const field of ['taskTypes', 'fallback'] as const) {
    const v = d[field]
    if (v === undefined || v === null) continue
    if (typeof v !== 'object' || Array.isArray(v)) return `${field} must be an object`
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!(HELPER_TASK_TYPES as readonly string[]).includes(k)) return `${field}: unknown task type "${k}"`
      if (field === 'taskTypes' && typeof val !== 'boolean') return `taskTypes.${k} must be a JSON boolean`
      if (field === 'fallback' && val !== 'skip' && val !== 'opus') return `fallback.${k} must be "skip" or "opus"`
    }
  }
  if (d.fallbackAgent !== undefined && d.fallbackAgent !== null && d.fallbackAgent !== '') {
    if (typeof d.fallbackAgent !== 'string' || !AGENT_ID_RE.test(d.fallbackAgent.trim())) {
      return 'fallbackAgent must be an agent id'
    }
    if (d.fallbackAgent.trim() === 'system') return 'fallbackAgent cannot be "system"'
  }
  return null
}

// Copies the helper fields of a validated body onto a def. A field absent from
// the body stays absent on the def, so a pre-helper payload saves exactly the
// five fields it always did.
export function copyHelperFields(def: CustomProviderDef, d: Record<string, unknown>): CustomProviderDef {
  if (typeof d.helperModel === 'string' && d.helperModel.trim()) def.helperModel = d.helperModel.trim()
  if (d.taskTypes && typeof d.taskTypes === 'object') {
    const tt: Partial<Record<HelperTaskType, boolean>> = {}
    for (const t of HELPER_TASK_TYPES) {
      const v = (d.taskTypes as Record<string, unknown>)[t]
      if (typeof v === 'boolean') tt[t] = v
    }
    def.taskTypes = tt
  }
  if (d.fallback && typeof d.fallback === 'object') {
    const fb: Partial<Record<HelperTaskType, HelperFallback>> = {}
    for (const t of HELPER_TASK_TYPES) {
      const v = (d.fallback as Record<string, unknown>)[t]
      if (v === 'skip' || v === 'opus') fb[t] = v
    }
    def.fallback = fb
  }
  if (typeof d.fallbackAgent === 'string' && d.fallbackAgent.trim()) def.fallbackAgent = d.fallbackAgent.trim()
  return def
}

interface ProvidersStore {
  providers: CustomProviderDef[]
}

function loadStore(): ProvidersStore {
  if (!existsSync(PROVIDERS_PATH)) return { providers: [] }
  try {
    return JSON.parse(readFileSync(PROVIDERS_PATH, 'utf-8')) as ProvidersStore
  } catch {
    return { providers: [] }
  }
}

function saveStore(store: ProvidersStore): void {
  atomicWriteFileSync(PROVIDERS_PATH, JSON.stringify(store, null, 2))
}

export function listCustomProviders(): CustomProviderDef[] {
  return loadStore().providers
}

export function loadCustomProvider(id: string): CustomProviderDef | null {
  return loadStore().providers.find(p => p.id === id) ?? null
}

export function saveCustomProvider(def: CustomProviderDef): void {
  const store = loadStore()
  const idx = store.providers.findIndex(p => p.id === def.id)
  if (idx >= 0) {
    store.providers[idx] = def
  } else {
    store.providers.push(def)
  }
  saveStore(store)
}

export function deleteCustomProvider(id: string): boolean {
  const store = loadStore()
  const before = store.providers.length
  store.providers = store.providers.filter(p => p.id !== id)
  if (store.providers.length === before) return false
  saveStore(store)
  return true
}

const VALID_AUTH_HEADERS = new Set<AuthHeaderType>(['x-api-key', 'Bearer', 'none'])

// Returns null if valid, or an error string.
export function validateCustomProvider(data: unknown): string | null {
  if (!data || typeof data !== 'object') return 'invalid payload'
  const d = data as Record<string, unknown>

  const id = typeof d.id === 'string' ? d.id.trim() : ''
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return 'id is required and must be alphanumeric/dash/underscore'
  }

  const label = typeof d.label === 'string' ? d.label.trim() : ''
  if (!label) return 'label is required'

  const baseUrl = typeof d.baseUrl === 'string' ? d.baseUrl.trim() : ''
  if (!baseUrl) return 'baseUrl is required'
  if (baseUrl.length > 512) return 'baseUrl too long (max 512)'

  // Shell-injection guard: the baseUrl is POSIX single-quote-escaped by the
  // helper (sq() in main-agent-custom-provider.mjs) before being interpolated
  // into the tmux launch command. Reject characters that are structurally
  // invalid in URLs anyway; single-quotes are handled by sq() but excluded here
  // to keep the validation conservative.
  // eslint-disable-next-line no-useless-escape
  if (/["$`\\;|&(){}<>'\s]/.test(baseUrl)) {
    return 'baseUrl contains disallowed characters (no quotes, shell metacharacters, or whitespace)'
  }

  // Parse with URL constructor to catch malformed inputs and verify the
  // hostname explicitly -- startsWith checks are vulnerable to prefix tricks
  // like http://localhost.evil.com or https://(empty host).
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch {
    return 'baseUrl is not a valid URL'
  }
  const protocol = parsed.protocol
  const hostname = parsed.hostname
  if (protocol !== 'https:' && protocol !== 'http:') {
    return 'baseUrl must use https:// or http://'
  }
  if (protocol === 'http:' && hostname !== 'localhost' && !hostname.startsWith('127.')) {
    return 'http:// is only allowed for localhost or 127.x.x.x'
  }
  if (!hostname) {
    return 'baseUrl must have a non-empty hostname'
  }

  const authHeader = d.authHeader as string
  if (!VALID_AUTH_HEADERS.has(authHeader as AuthHeaderType)) {
    return 'authHeader must be x-api-key, Bearer, or none'
  }

  const vaultKey = d.vaultKey === null || d.vaultKey === undefined ? null : String(d.vaultKey).trim()
  if (authHeader !== 'none' && !vaultKey) {
    return 'vaultKey is required unless authHeader is none'
  }

  return validateHelperFields(d)
}
