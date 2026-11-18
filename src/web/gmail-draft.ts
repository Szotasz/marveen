// GMAILDRAFT1116: the owner's Gmail DRAFT writer, inside the dashboard process. It writes one draft and never sends.
//
// Why it lives here (PR #2824 review B1). The first version was a pinned Python writer that agents ran; it needed the
// owner's gmail.compose refresh token and OAuth client from the shared vault, and the vault API answers every holder of
// the shared dashboard token. gmail.compose can also SEND, so any agent could have used the credential from a script of
// its own. Now:
//   - the credential is two RESERVED vault entries (vault-reserved.ts): no generic vault route, binding, listing or
//     vault.ts getSecret() call hands them out, for any principal; only this module reads them, through
//     reservedVaultAccess, in this process;
//   - the owner stores them through an owner-only route (routes/gmail-draft.ts) that never returns them;
//   - this module's whole network reach is ALLOWED_GMAIL_REQUESTS below: the OAuth token endpoint (refresh grant),
//     users.drafts.create, and users.drafts.get of the draft it has just written (the read-back). There is no
//     drafts.send, no messages.send, insert or import, and every request is checked against that list before it goes.
//
// THREAT MODEL, honestly. The adversary is an agent (or a prompt-injected one) that wants a letter to leave the owner's
// mailbox without the owner's approval. What this closes: the API path the reviewer measured (read the credential
// through the vault API, then send with it from any script). What it does NOT close: the OS path. Every agent runs as
// the same OS user; store/vault.json is readable by that user; the vault master key sits in the macOS login Keychain
// stored with `-A` (keychain.ts: any process of the user reads it without a prompt) or in store/.vault-key. An agent
// that runs `security find-generic-password` (or reads the key file) and decrypts vault.json itself still gets the
// refresh token, and with it can send. The full fix is the OS-user split (vault-acl.ts calls it F3). Until then this
// is an access rule and a trail for the API, not isolation.
//
// What a caller can still do with this endpoint: put a draft into the owner's own mailbox (never send it). A person
// sends it later through the levelled paths (email-approval-gate.py gates drafts.send, messages.send, send_draft.py and
// the MCP send tools exactly as before).
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, constants as fsConstants } from 'node:fs'
import { join, sep, basename, isAbsolute, normalize } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { readEnvFile } from '../env.js'
import { gmailDraftAgents } from './gmail-draft-policy.js'
import { reservedVaultAccess } from './vault.js'

export { gmailDraftAgents }

// ---- the credential -----------------------------------------------------------------------------------------------

export const GMAIL_DRAFT_CLIENT_ID = 'gmail-draft-oauth-client'
export const GMAIL_DRAFT_REFRESH_ID = 'gmail-draft-compose-refresh'
// The ids the first version of this PR asked the owner to store. They are reserved too (vault-reserved.ts reads '_' as
// '-'), so if they exist they are no longer served by the vault API; they are read here as a fallback only.
const LEGACY_CLIENT_ID = 'GMAIL_DRAFT_OAUTH_CLIENT'
const LEGACY_REFRESH_ID = 'GMAIL_DRAFT_COMPOSE_REFRESH'

interface OAuthClient { client_id: string; client_secret: string }

export class DraftError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'DraftError'
  }
}

function parseClient(raw: unknown): OAuthClient | null {
  let v: unknown = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const c = (o.installed ?? o.web ?? o) as Record<string, unknown>
  if (!c || typeof c !== 'object') return null
  const id = c.client_id, secret = c.client_secret
  if (typeof id !== 'string' || typeof secret !== 'string' || !id.trim() || !secret.trim()) return null
  if (id.length > 512 || secret.length > 512 || /[\s]/.test(id) || /[\s]/.test(secret)) return null
  return { client_id: id.trim(), client_secret: secret.trim() }
}

const REFRESH_RE = /^[\x21-\x7e]{10,2048}$/

/** Owner-only (the route checks): store the OAuth client (the JSON Google gives, or {client_id, client_secret}) and
 *  the gmail.compose refresh token. Returns nothing about the values. */
export function setGmailDraftCredentials(client: unknown, refreshToken: unknown): void {
  const c = parseClient(client)
  if (!c) throw new DraftError(400, 'bad-client', 'client must be the OAuth client JSON (installed/web) or {client_id, client_secret}')
  if (typeof refreshToken !== 'string' || !REFRESH_RE.test(refreshToken.trim())) {
    throw new DraftError(400, 'bad-refresh-token', 'refreshToken must be one printable token without spaces (10..2048 characters)')
  }
  reservedVaultAccess.write(GMAIL_DRAFT_CLIENT_ID, 'Gmail draft endpoint: OAuth client (reserved)', JSON.stringify(c))
  reservedVaultAccess.write(GMAIL_DRAFT_REFRESH_ID, 'Gmail draft endpoint: gmail.compose refresh token (reserved)', refreshToken.trim())
  tokenCache = null
}

export function clearGmailDraftCredentials(): boolean {
  tokenCache = null
  let removed = false
  for (const id of [GMAIL_DRAFT_CLIENT_ID, GMAIL_DRAFT_REFRESH_ID, LEGACY_CLIENT_ID, LEGACY_REFRESH_ID]) {
    if (reservedVaultAccess.remove(id)) removed = true
  }
  return removed
}

export function gmailDraftConfigured(): boolean {
  return (reservedVaultAccess.present(GMAIL_DRAFT_CLIENT_ID) || reservedVaultAccess.present(LEGACY_CLIENT_ID))
    && (reservedVaultAccess.present(GMAIL_DRAFT_REFRESH_ID) || reservedVaultAccess.present(LEGACY_REFRESH_ID))
}

function readCredentials(): { client: OAuthClient; refresh: string } {
  const clientRaw = reservedVaultAccess.read(GMAIL_DRAFT_CLIENT_ID) ?? reservedVaultAccess.read(LEGACY_CLIENT_ID)
  const refresh = (reservedVaultAccess.read(GMAIL_DRAFT_REFRESH_ID) ?? reservedVaultAccess.read(LEGACY_REFRESH_ID) ?? '').trim()
  const client = parseClient(clientRaw)
  if (!client || !refresh) {
    throw new DraftError(409, 'not-configured', 'The Gmail draft credential is not set: the owner stores it with PUT /api/gmail/draft/credentials')
  }
  return { client, refresh }
}

// ---- the network: a closed list -----------------------------------------------------------------------------------

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const DRAFTS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts'
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Every request this module may make. Anything else is refused before it is sent (tested: drafts/send,
 *  messages/send, messages, import, insert and any other host or method are not on it). */
export const ALLOWED_GMAIL_REQUESTS: ReadonlyArray<{ method: 'GET' | 'POST'; test: (url: string) => boolean; what: string }> = Object.freeze([
  { method: 'POST', test: (u: string) => u === TOKEN_URL, what: 'OAuth refresh grant' },
  { method: 'POST', test: (u: string) => u === DRAFTS_URL, what: 'users.drafts.create' },
  {
    method: 'GET',
    test: (u: string) => u.startsWith(DRAFTS_URL + '/') && u.endsWith('?format=full')
      && DRAFT_ID_RE.test(u.slice(DRAFTS_URL.length + 1, -'?format=full'.length)),
    what: 'users.drafts.get (read-back of the draft just written)',
  },
])

export function isAllowedGmailRequest(method: string, url: string): boolean {
  return ALLOWED_GMAIL_REQUESTS.some(r => r.method === method && r.test(url))
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>
let fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>

/** Tests only: a mocked Gmail. Returns the previous implementation. */
export function _setGmailFetchForTest(f: FetchLike | null): FetchLike {
  const prev = fetchImpl
  fetchImpl = f ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>)
  return prev
}

// The access token can send. Node's fetch takes a proxy from the environment only with NODE_USE_ENV_PROXY, and extra
// CA roots only from NODE_EXTRA_CA_CERTS (read at start-up): with either set, this process could hand the token to a
// TLS endpoint the environment chose, so the writer refuses to run instead (the old writer dropped the same settings).
export function unsafeNetworkEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of ['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS']) {
    if ((env[k] ?? '').trim()) return k
  }
  return null
}

async function gmailRequest(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: string, timeoutMs = 60_000) {
  if (!isAllowedGmailRequest(method, url)) throw new DraftError(500, 'request-not-allowed', `refused: ${method} is not an allowed Gmail request`)
  const bad = unsafeNetworkEnv()
  if (bad) throw new DraftError(500, 'unsafe-network-env', `refused: ${bad} is set in the dashboard's environment; the draft writer does not send the token through it`)
  try {
    return await fetchImpl(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new DraftError(502, 'gmail-unreachable', `Gmail could not be reached (${(err as Error).name})`)
  }
}

async function errorText(resp: { text(): Promise<string> }): Promise<string> {
  try {
    const t = await resp.text()
    try {
      const j = JSON.parse(t) as { error?: { message?: unknown } | string; error_description?: unknown }
      const m = typeof j.error === 'object' ? j.error?.message : (j.error_description ?? j.error)
      if (typeof m === 'string') return m.slice(0, 200)
    } catch { /* not JSON */ }
    return t.slice(0, 200)
  } catch { return '' }
}

let tokenCache: { token: string; exp: number } | null = null

/** Tests only: forget the cached access token. */
export function _resetGmailDraftStateForTest(): void { tokenCache = null }

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.token
  const { client, refresh } = readCredentials()
  const form = new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: refresh, grant_type: 'refresh_token' })
  const resp = await gmailRequest('POST', TOKEN_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, form.toString(), 20_000)
  if (!resp.ok) throw new DraftError(502, 'token-refresh-failed', `token refresh failed (${resp.status}): ${await errorText(resp)}`)
  const j = await resp.json() as { access_token?: unknown; expires_in?: unknown }
  if (typeof j.access_token !== 'string' || !j.access_token) throw new DraftError(502, 'token-refresh-failed', 'token refresh answered without an access token')
  const ttl = typeof j.expires_in === 'number' && j.expires_in > 120 ? j.expires_in : 600
  tokenCache = { token: j.access_token, exp: Date.now() + (ttl - 60) * 1000 }
  return j.access_token
}

// ---- who may call ---------------------------------------------------------------------------------------------------

export type DraftCallerAuth = { kind: string; user?: string; agent?: string; tokenAgent?: string; device?: string; peer?: string } | undefined

export interface DraftCaller {
  kind: 'owner' | 'main-token' | 'claimed-agent' | 'agent-token'
  principal: string
  /** The verified-recipient ledger binds this call (sub-agents always, the main agent when its switch is on). */
  ledger: boolean
  /** MAIL_OWNER_CC binds this call (every agent caller; the owner typing it does not need a copy check). */
  ownerCc: boolean
}

/** The principal matrix (tested): the owner (session, or a key with the owner's session beside it) and the shared
 *  (main) token may write a draft; a sub-agent's OWN token only when GMAIL_DRAFT_AGENTS lists it (default: none); a
 *  shared-token caller that CLAIMS a sub-agent name (X-Agent-Id) is held to the same list: the claim is self-asserted,
 *  so this binds an honest caller and leaves a trail, it does not authenticate anyone. Federation peers and device
 *  keys without the owner are refused; no credential is 401 (the gate answers that before any route runs). */
export function draftCallerOf(auth: DraftCallerAuth, isOwner: boolean, mainAgentId: string, listed: Set<string> = gmailDraftAgents()): DraftCaller | DraftError {
  if (!auth || auth.kind === 'none') return new DraftError(401, 'unauthenticated', 'Authentication required')
  if (isOwner) return { kind: 'owner', principal: auth.user ?? 'owner', ledger: false, ownerCc: false }
  if (auth.kind !== 'token') return new DraftError(403, 'gmail-draft-principal', 'Only the owner, the main agent and the sub-agents listed in GMAIL_DRAFT_AGENTS may write a Gmail draft')
  const ledgerSwitch = ['1', 'true', 'yes', 'on'].includes((readEnvFile(['MAIN_AGENT_RECIPIENT_LEDGER']).MAIN_AGENT_RECIPIENT_LEDGER ?? '').trim().toLowerCase())
  if (auth.tokenAgent) {
    if (!listed.has(auth.tokenAgent)) return new DraftError(403, 'gmail-draft-agent-not-listed', `agent ${auth.tokenAgent} is not listed in GMAIL_DRAFT_AGENTS; send the draft request to ${mainAgentId}`)
    return { kind: 'agent-token', principal: auth.tokenAgent, ledger: true, ownerCc: true }
  }
  const claimed = typeof auth.agent === 'string' ? auth.agent.trim() : ''
  if (claimed && claimed !== mainAgentId) {
    if (!listed.has(claimed)) return new DraftError(403, 'gmail-draft-agent-not-listed', `agent ${claimed} is not listed in GMAIL_DRAFT_AGENTS; send the draft request to ${mainAgentId}`)
    return { kind: 'claimed-agent', principal: claimed, ledger: true, ownerCc: true }
  }
  return { kind: 'main-token', principal: claimed || 'token', ledger: ledgerSwitch, ownerCc: true }
}

// ---- the request body -----------------------------------------------------------------------------------------------

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_TOTAL_FILE_BYTES = 25 * 1024 * 1024
export const MAX_TEXT_CHARS = 2 * 1024 * 1024
export const MAX_HTML_CHARS = 5 * 1024 * 1024
export const MAX_FILES = 20
export const MAX_RECIPIENTS = 100

export interface DraftInput {
  to?: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  text: string
  html?: string
  inReplyTo?: string
  threadId?: string
  attachments?: string[]
  inline?: string[]
  alsoAttach?: boolean
}

const KNOWN_KEYS = new Set(['to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo', 'threadId', 'attachments', 'inline', 'alsoAttach'])
// A CR or LF in a header value would add a header (a Bcc nobody read); every other C0 control and DEL is refused too.
const HEADER_CTL = /[\x00-\x1f\x7f]/
const BREAK = /[\r\n]/
const ADDR_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const NAME_BAD = /[\x00-\x1f\x7f<>"\\,;]/
const MSGID_RE = /^<?([\x21-\x3b\x3d\x3f-\x7e]{1,900})>?$/

export interface Address { addr: string; name?: string }

function headerValueChecked(field: string, v: string): void {
  if (BREAK.test(v)) throw new DraftError(400, 'header-line-break', `${field} holds a line break`)
  if (HEADER_CTL.test(v)) throw new DraftError(400, 'header-control-char', `${field} holds a control character`)
}

export function parseAddressList(field: string, value: unknown): Address[] {
  if (value === undefined || value === null || value === '') return []
  const items = Array.isArray(value) ? value : [value]
  const out: Address[] = []
  for (const item of items) {
    if (typeof item !== 'string') throw new DraftError(400, 'bad-address', `${field}: every recipient is a string`)
    headerValueChecked(field, item)
    for (const piece of item.split(/[,;]/)) {
      const p = piece.trim()
      if (!p) continue
      const m = p.match(/^(.*?)\s*<([^<>]+)>$/)
      const addr = (m ? m[2] : p).trim()
      let name = m ? m[1].trim() : ''
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).trim()
      if (!ADDR_RE.test(addr)) throw new DraftError(400, 'bad-address', `${field}: not one plain address: ${p.slice(0, 120)}`)
      if (name && (NAME_BAD.test(name) || name.length > 100)) throw new DraftError(400, 'bad-address', `${field}: the display name may not hold < > " \\ , ; or control characters`)
      out.push(name ? { addr, name } : { addr })
    }
  }
  return out
}

export interface CheckedDraft {
  to: Address[]; cc: Address[]; bcc: Address[]
  subject: string; text: string; html?: string
  inReplyTo?: string; threadId?: string
  attachments: string[]; inline: string[]; alsoAttach: boolean
}

export function checkDraftInput(raw: unknown): CheckedDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DraftError(400, 'bad-body', 'the body is one JSON object')
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).filter(k => !KNOWN_KEYS.has(k))
  if (unknown.length) throw new DraftError(400, 'unknown-field', `unknown field(s): ${unknown.slice(0, 5).join(', ')}`)
  if (typeof o.subject !== 'string' || !o.subject.trim()) throw new DraftError(400, 'bad-subject', 'subject is a non-empty string')
  if (o.subject.length > 998) throw new DraftError(400, 'bad-subject', 'subject is at most 998 characters')
  headerValueChecked('subject', o.subject)
  if (typeof o.text !== 'string') throw new DraftError(400, 'bad-text', 'text (the plain-text body) is a string')
  if (o.text.length > MAX_TEXT_CHARS) throw new DraftError(413, 'text-too-large', 'text is too large')
  if (o.html !== undefined && (typeof o.html !== 'string' || o.html.length > MAX_HTML_CHARS)) throw new DraftError(400, 'bad-html', 'html is a string of at most 5 MB')
  let inReplyTo: string | undefined
  if (o.inReplyTo !== undefined && o.inReplyTo !== '') {
    if (typeof o.inReplyTo !== 'string') throw new DraftError(400, 'bad-in-reply-to', 'inReplyTo is a string')
    headerValueChecked('inReplyTo', o.inReplyTo)
    const m = o.inReplyTo.trim().match(MSGID_RE)
    if (!m) throw new DraftError(400, 'bad-in-reply-to', 'inReplyTo is one Message-ID')
    inReplyTo = `<${m[1]}>`
  }
  let threadId: string | undefined
  if (o.threadId !== undefined && o.threadId !== '') {
    if (typeof o.threadId !== 'string' || !DRAFT_ID_RE.test(o.threadId)) throw new DraftError(400, 'bad-thread-id', 'threadId is not a Gmail thread id')
    threadId = o.threadId
  }
  const names = (k: 'attachments' | 'inline'): string[] => {
    const v = o[k]
    if (v === undefined) return []
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw new DraftError(400, 'bad-file-list', `${k} is a list of file names under store/outbox/`)
    return v as string[]
  }
  const attachments = names('attachments')
  const inline = names('inline')
  if (attachments.length + inline.length > MAX_FILES) throw new DraftError(400, 'too-many-files', `at most ${MAX_FILES} files`)
  if (inline.length && o.html === undefined) throw new DraftError(400, 'inline-needs-html', 'inline images need an html body')
  if (o.alsoAttach !== undefined && typeof o.alsoAttach !== 'boolean') throw new DraftError(400, 'bad-also-attach', 'alsoAttach is a boolean')
  const to = parseAddressList('to', o.to), cc = parseAddressList('cc', o.cc), bcc = parseAddressList('bcc', o.bcc)
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new DraftError(400, 'too-many-recipients', `at most ${MAX_RECIPIENTS} recipients`)
  return {
    to, cc, bcc, subject: o.subject, text: o.text, html: o.html as string | undefined, inReplyTo, threadId,
    attachments, inline, alsoAttach: o.alsoAttach === true,
  }
}

// ---- files: only from store/outbox/ (review N1) ----------------------------------------------------------------------

export const OUTBOX_DIR_NAME = 'outbox'
// The second line, kept from the reviewed writer: even inside the outbox, a hidden or secret-looking name is refused.
const SECRET_NAME = /token|vault|secret|credential|passw|\.(pem|key|p12|pfx|der|crt|kdbx)$|^id_|_ed25519|_rsa|^\.env/i

export function outboxDir(): string {
  return join(STORE_DIR, OUTBOX_DIR_NAME)
}

/** One file by its name under store/outbox/, read through a descriptor: the name is relative (no absolute path, no
 *  '..', no backslash, no hidden or secret-looking component), store/outbox itself is a real directory (not a symlink),
 *  the file's realpath stays inside it (a symlink pointing out is refused), it is a regular file and at most 25 MB.
 *  Known limit: a hard link, or a copy made into the outbox first, passes (the rule is about the path, not content);
 *  a directory swapped between the check and the open is not closed by O_NOFOLLOW on the last component alone. */
export function readOutboxFile(name: string): { name: string; data: Buffer } {
  const bad = (why: string) => new DraftError(400, 'outbox-file-refused', `${why}: ${String(name).slice(0, 200)}`)
  if (typeof name !== 'string' || !name || name.length > 255 || name.includes('\0')) throw bad('not a file name')
  if (isAbsolute(name) || name.includes('\\')) throw bad('a file name relative to store/outbox/ is needed')
  const parts = name.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw bad('no empty, "." or ".." component')
  if (parts.some(p => p.startsWith('.') || SECRET_NAME.test(p))) throw bad('a hidden or secret-looking name is not used')
  const dir = outboxDir()
  let realDir: string
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw bad('store/outbox is not a plain directory')
    realDir = realpathSync.native(dir)
    if (realDir !== join(realpathSync.native(STORE_DIR), OUTBOX_DIR_NAME)) throw bad('store/outbox resolves elsewhere')
  } catch (err) {
    if (err instanceof DraftError) throw err
    throw new DraftError(400, 'outbox-missing', 'store/outbox/ does not exist: put the files to attach there first')
  }
  let real: string
  try { real = realpathSync.native(join(dir, normalize(name))) } catch { throw bad('no such file in store/outbox/') }
  if (!real.startsWith(realDir + sep)) throw bad('the file resolves outside store/outbox/')
  let fd: number
  try { fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)) } catch { throw bad('cannot open') }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw bad('not a regular file')
    if (st.size > MAX_FILE_BYTES) throw bad('file over 25 MB')
    const data = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, data, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    return { name: basename(real), data: data.subarray(0, off) }
  } finally {
    closeSync(fd)
  }
}

// ---- owner copy and the recipient ledger ----------------------------------------------------------------------------

/** MAILCCGATE1016, as the gate applies it to a draft: with MAIL_OWNER_CC set in the install .env, the owner's address
 *  is in to, cc or bcc. */
export function ownerCcMissing(d: CheckedDraft): string | null {
  const owner = (readEnvFile(['MAIL_OWNER_CC']).MAIL_OWNER_CC ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  if (!owner) return null
  const all = [...d.to, ...d.cc, ...d.bcc].map(a => a.addr.toLowerCase())
  return all.includes(owner) ? null : owner
}

interface LedgerModule {
  inspectLedger(path: string): { ledger: { recipients: Record<string, unknown> } | null; missing: boolean; reason: string | null }
  isVerifiedIn(ledger: unknown, address: string): boolean
}
let ledgerLoader: () => Promise<LedgerModule> = async () =>
  await import(pathToFileURL(join(PROJECT_ROOT, 'scripts', 'recipient-ledger.mjs')).href) as LedgerModule

/** Tests only. */
export function _setLedgerLoaderForTest(f: (() => Promise<LedgerModule>) | null): void {
  ledgerLoader = f ?? (async () => await import(pathToFileURL(join(PROJECT_ROOT, 'scripts', 'recipient-ledger.mjs')).href) as LedgerModule)
}

/** The verified-recipient ledger (store/verified-recipients.json, scripts/recipient-ledger.mjs), fail-closed: an
 *  unloadable module or an unusable ledger refuses, as the gate does. Returns the unverified addresses. */
export async function unverifiedRecipients(d: CheckedDraft): Promise<string[]> {
  const all = [...d.to, ...d.cc, ...d.bcc].map(a => a.addr)
  if (!all.length) return []
  let mod: LedgerModule
  try { mod = await ledgerLoader() } catch { throw new DraftError(500, 'ledger-unavailable', 'the recipient ledger module does not load: fail-closed') }
  const r = mod.inspectLedger(join(STORE_DIR, 'verified-recipients.json'))
  if (!r.ledger) throw new DraftError(400, 'ledger-unusable', `the recipient ledger is not usable: ${r.reason ?? 'unknown'}`)
  return all.filter(a => !mod.isVerifiedIn(r.ledger, a))
}

// ---- the MIME letter (Gmail's own composer form for inline images) ---------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html', json: 'application/json',
  // Gmail drops text/calendar parts of API-created drafts; application/ics survives (measured with the old writer).
  ics: 'application/ics', zip: 'application/zip', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mp3: 'audio/mpeg',
}
function mimeTypeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

function b64lines(data: Buffer): string {
  return (data.toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n')
}

/** RFC 2047 encoded words (B), split on character boundaries so no word is over 75 characters. */
export function encodeHeaderWords(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v
  const words: string[] = []
  let chunk = ''
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = '' }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

function formatAddress(a: Address): string {
  if (!a.name) return a.addr
  return /^[\x20-\x7e]*$/.test(a.name) ? `"${a.name}" <${a.addr}>` : `${encodeHeaderWords(a.name)} <${a.addr}>`
}

function fileNameParams(name: string): string {
  const safe = /^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)
  if (safe) return `name="${name}"`
  return `name="${encodeHeaderWords(name).replace(/\r\n /g, ' ')}"`
}
function dispositionParams(name: string): string {
  const safe = /^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)
  if (safe) return `filename="${name}"`
  return `filename*=UTF-8''${encodeURIComponent(name)}`
}

function boundary(): string {
  return '=_mv_' + randomBytes(12).toString('hex')
}

function newInlineId(): string {
  // Gmail's composer form: ii_ plus 10 lower-case alphanumerics.
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const b = randomBytes(10)
  return 'ii_' + Array.from(b, x => abc[x % abc.length]).join('')
}

/** (width, height) of a PNG or JPEG, else null: Gmail's composer gives an inline image its size. */
export function imageSize(data: Buffer): [number, number] | null {
  try {
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return [data.readUInt32BE(16), data.readUInt32BE(20)]
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let i = 2
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) { i += 1; continue }
        const mk = data[i + 1]
        if (mk === 0xc0 || mk === 0xc1 || mk === 0xc2) return [data.readUInt16BE(i + 7), data.readUInt16BE(i + 5)]
        i += 2 + data.readUInt16BE(i + 2)
      }
    }
  } catch { /* truncated */ }
  return null
}

function fixImgTag(tag: string, size: [number, number] | null): string {
  if (!size) return tag
  const [w, h] = size
  const wm = tag.match(/\swidth="?(\d+)/)
  const hm = tag.match(/\sheight="?(\d+)/)
  const head = tag.slice(0, -1).replace(/[/\s]+$/, '')
  if (wm && !hm && w) return `${head} height="${Math.round(Number(wm[1]) * h / w)}">`
  if (!wm && !hm) return `${head} width="${w}" height="${h}">`
  return tag
}

interface Part { headers: string[]; body: string }
function render(p: Part): string { return p.headers.join('\r\n') + '\r\n\r\n' + p.body }
function textPart(sub: 'plain' | 'html', s: string): Part {
  return { headers: [`Content-Type: text/${sub}; charset="UTF-8"`, 'Content-Transfer-Encoding: base64'], body: b64lines(Buffer.from(s, 'utf8')) }
}
function filePart(name: string, data: Buffer, cid?: string): Part {
  const headers = [
    `Content-Type: ${mimeTypeOf(name)}; ${fileNameParams(name)}`,
    `Content-Disposition: attachment; ${dispositionParams(name)}`,
    'Content-Transfer-Encoding: base64',
  ]
  if (cid) headers.push(`X-Attachment-Id: ${cid}`, `Content-ID: <${cid}>`)
  return { headers, body: b64lines(data) }
}
function multipart(sub: 'mixed' | 'related' | 'alternative', parts: Part[]): Part {
  const b = boundary()
  return { headers: [`Content-Type: multipart/${sub}; boundary="${b}"`], body: parts.map(p => `--${b}\r\n${render(p)}\r\n`).join('') + `--${b}--` }
}

export interface BuiltLetter { raw: string; wantFiles: string[] }

/** [multipart/mixed >] [multipart/related >] (alternative(text, html) | text), inline images, attachments. */
export function buildLetter(d: CheckedDraft, files: { inline: Array<{ name: string; data: Buffer }>; attachments: Array<{ name: string; data: Buffer }> }): BuiltLetter {
  let html = d.html
  const imgs: Array<{ name: string; data: Buffer; cid: string }> = []
  for (const f of files.inline) {
    const cid = newInlineId()
    imgs.push({ ...f, cid })
    if (html !== undefined) {
      html = html.split(`cid:${f.name}`).join(`cid:${cid}`)
      const size = imageSize(f.data)
      html = html.replace(/<img\b[^>]*>/gi, (tag) => tag.includes(`cid:${cid}`) ? fixImgTag(tag, size) : tag)
    }
  }
  let body: Part = html === undefined ? textPart('plain', d.text) : multipart('alternative', [textPart('plain', d.text), textPart('html', html)])
  if (imgs.length) body = multipart('related', [body, ...imgs.map(i => filePart(i.name, i.data, i.cid))])
  const extra = [...files.attachments, ...(d.alsoAttach ? imgs.map(i => ({ name: i.name, data: i.data })) : [])]
  if (extra.length) body = multipart('mixed', [body, ...extra.map(f => filePart(f.name, f.data))])
  const top: string[] = ['MIME-Version: 1.0']
  if (d.to.length) top.push(`To: ${d.to.map(formatAddress).join(', ')}`)
  if (d.cc.length) top.push(`Cc: ${d.cc.map(formatAddress).join(', ')}`)
  if (d.bcc.length) top.push(`Bcc: ${d.bcc.map(formatAddress).join(', ')}`)
  top.push(`Subject: ${encodeHeaderWords(d.subject)}`)
  if (d.inReplyTo) top.push(`In-Reply-To: ${d.inReplyTo}`, `References: ${d.inReplyTo}`)
  const raw = [...top, ...body.headers].join('\r\n') + '\r\n\r\n' + body.body + '\r\n'
  return { raw, wantFiles: [...extra.map(f => f.name), ...imgs.map(i => i.name)] }
}

// ---- the whole draft ------------------------------------------------------------------------------------------------

export interface DraftResult {
  draftId: string
  messageId?: string
  readback: { ok: boolean; problems: string[]; to: string; attachments: string[] }
}

export function subjectHash(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 16)
}

export async function writeGmailDraft(d: CheckedDraft): Promise<DraftResult> {
  const inline = d.inline.map(readOutboxFile)
  const attachments = d.attachments.map(readOutboxFile)
  const total = [...inline, ...attachments].reduce((n, f) => n + f.data.length, 0)
  if (total > MAX_TOTAL_FILE_BYTES) throw new DraftError(413, 'files-too-large', 'the files together are over 25 MB')
  const letter = buildLetter(d, { inline, attachments })
  const at = await accessToken()
  const message: Record<string, string> = { raw: Buffer.from(letter.raw, 'utf8').toString('base64url') }
  if (d.threadId) message.threadId = d.threadId
  const resp = await gmailRequest('POST', DRAFTS_URL, { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, JSON.stringify({ message }))
  if (!resp.ok) {
    if (resp.status === 401) tokenCache = null
    throw new DraftError(502, 'gmail-error', `Gmail answered ${resp.status}: ${await errorText(resp)}`)
  }
  const created = await resp.json() as { id?: unknown; message?: { id?: unknown } }
  const draftId = typeof created.id === 'string' ? created.id : ''
  if (!DRAFT_ID_RE.test(draftId)) throw new DraftError(502, 'gmail-error', 'Gmail answered without a usable draft id')
  const readback = await readBack(at, draftId, d, letter.wantFiles)
  const messageId = typeof created.message?.id === 'string' ? created.message.id : undefined
  return { draftId, ...(messageId ? { messageId } : {}), readback }
}

/** Read the draft back (users.drafts.get) and check every to/cc recipient and every file is in it. */
async function readBack(at: string, draftId: string, d: CheckedDraft, wantFiles: string[]): Promise<DraftResult['readback']> {
  const resp = await gmailRequest('GET', `${DRAFTS_URL}/${draftId}?format=full`, { Authorization: `Bearer ${at}` })
  if (!resp.ok) return { ok: false, problems: [`cannot read the draft back (${resp.status})`], to: '', attachments: [] }
  type P = { filename?: string; parts?: P[]; headers?: Array<{ name: string; value: string }> }
  const j = await resp.json() as { message?: { payload?: P } }
  const payload = j.message?.payload ?? {}
  const names: string[] = []
  const stack: P[] = [payload]
  while (stack.length) {
    const p = stack.pop() as P
    if (p.filename) names.push(p.filename)
    stack.push(...(p.parts ?? []))
  }
  const hdr: Record<string, string> = {}
  for (const h of payload.headers ?? []) hdr[String(h.name).toLowerCase()] = String(h.value)
  const problems = wantFiles.filter(f => !names.includes(f) && !names.some(n => n.endsWith(f))).map(f => `missing attachment: ${f}`)
  for (const [field, list] of [['to', d.to], ['cc', d.cc]] as const) {
    const got = (hdr[field] ?? '').toLowerCase()
    for (const a of list) if (!got.includes(a.addr.toLowerCase())) problems.push(`missing ${field} recipient: ${a.addr}`)
  }
  return { ok: problems.length === 0, problems, to: hdr.to ?? '', attachments: names }
}
