// Only Anthropic-Messages-compatible endpoints are supported (/v1/messages).
// Pure OpenAI endpoints require a translation proxy (out of scope).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

const PROVIDERS_PATH = join(PROJECT_ROOT, 'store', 'custom-providers.json')

export type AuthHeaderType = 'x-api-key' | 'Bearer' | 'none'

export interface CustomProviderDef {
  id: string
  label: string
  baseUrl: string
  authHeader: AuthHeaderType
  vaultKey: string | null
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

  return null
}
