// Colleague board accounts: owner-managed logins for people who should see
// only their own kanban cards (docs/board-access.md, "Colleague login").
//
// Each account is a username, a password hash and the board-access.json person
// it signs in as. The person decides WHICH cards are visible (board-access.ts);
// the account only decides WHO may sign in as that person. The owner creates,
// resets and disables accounts (owner session only, routes/colleague.ts, or the
// machine-local CLI scripts/colleague-account.ts).
//
// Stored in store/colleague-accounts.json (gitignored, written 0600):
//   { "version": 1,
//     "accounts": { "<username>": { "person": "<personId>", "passwordHash": "$scrypt$...",
//                                   "disabled": false, "generation": 1,
//                                   "createdAt": <unix s>, "updatedAt": <unix s> } } }
//
// The hash is the owner login's own scheme (password-hash.ts: scrypt, PHC
// string). It never leaves this module except to verifyPassword: every listing
// goes through publicAccount(), a projection onto named fields.
//
// `generation` is bumped by every password reset and every disable. A session
// remembers the generation it was minted under (colleague-sessions.ts), so a
// reset or a disable ends every open session on the very next request, also
// when the change was made by the CLI in another process.
//
// Fail-closed reading: a missing file is "no accounts"; a file that exists but
// is not a readable JSON object is `broken`: nobody can sign in, every session
// is refused, and writes refuse to overwrite it (the owner fixes it by hand).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { hashPassword } from './password-hash.js'

export const COLLEAGUE_ACCOUNTS_PATH = join(STORE_DIR, 'colleague-accounts.json')

/** Login names: lower case, so a login is case-insensitive by construction. */
export const COLLEAGUE_USERNAME_RE = /^[a-z0-9._-]{1,64}$/
/** The board-access.json person id rule (board-access.ts ID_RE). */
export const COLLEAGUE_PERSON_RE = /^[A-Za-z0-9_.@-]{1,64}$/

export interface ColleagueAccount {
  username: string
  person: string
  passwordHash: string
  disabled: boolean
  generation: number
  createdAt: number
  updatedAt: number
}

/** What any caller outside this module may see of an account. Never the hash. */
export interface PublicColleagueAccount {
  username: string
  person: string
  disabled: boolean
  createdAt: number
  updatedAt: number
}

export type ColleagueAccounts =
  | { broken: false; accounts: Map<string, ColleagueAccount> }
  | { broken: true; accounts: Map<string, ColleagueAccount> }

export class ColleagueAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 = 400) {
    super(message)
    this.name = 'ColleagueAccountError'
  }
}

export function normaliseUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const u = raw.trim().toLowerCase()
  return COLLEAGUE_USERNAME_RE.test(u) ? u : null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function intOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d
}

/** Normalise a parsed file. A malformed ENTRY is dropped (that account cannot sign in); a non-object file is broken. */
export function normaliseColleagueAccounts(raw: unknown): ColleagueAccounts {
  const accounts = new Map<string, ColleagueAccount>()
  if (!isPlainObject(raw)) return { broken: true, accounts }
  const list = isPlainObject(raw.accounts) ? raw.accounts : {}
  for (const [key, a] of Object.entries(list)) {
    const username = normaliseUsername(key)
    if (!username || username !== key || !isPlainObject(a)) continue
    if (typeof a.person !== 'string' || !COLLEAGUE_PERSON_RE.test(a.person)) continue
    if (typeof a.passwordHash !== 'string' || !a.passwordHash.startsWith('$')) continue
    accounts.set(username, {
      username,
      person: a.person,
      passwordHash: a.passwordHash,
      // Only literal false keeps an account usable: a typo disables, never enables.
      disabled: a.disabled !== false,
      generation: Math.max(1, intOr(a.generation, 1)),
      createdAt: intOr(a.createdAt, 0),
      updatedAt: intOr(a.updatedAt, 0),
    })
  }
  return { broken: false, accounts }
}

// The session check reads the file on every colleague request; a stat-keyed
// cache keeps that to one stat when nothing changed. Keyed by path, so tests
// with their own file do not see each other's entries.
const cache = new Map<string, { mtimeMs: number; size: number; value: ColleagueAccounts }>()

export function readColleagueAccounts(path: string = COLLEAGUE_ACCOUNTS_PATH): ColleagueAccounts {
  if (!existsSync(path)) {
    cache.delete(path)
    return { broken: false, accounts: new Map() }
  }
  let st: { mtimeMs: number; size: number }
  try { st = statSync(path) } catch { return { broken: true, accounts: new Map() } }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value
  let value: ColleagueAccounts
  try {
    value = normaliseColleagueAccounts(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    value = { broken: true, accounts: new Map() }
  }
  if (value.broken) logger.warn({ path }, 'colleague-accounts: unreadable, no colleague can sign in until it is fixed')
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

export function publicAccount(a: ColleagueAccount): PublicColleagueAccount {
  return { username: a.username, person: a.person, disabled: a.disabled, createdAt: a.createdAt, updatedAt: a.updatedAt }
}

export function listColleagueAccounts(path: string = COLLEAGUE_ACCOUNTS_PATH): PublicColleagueAccount[] {
  const r = readColleagueAccounts(path)
  if (r.broken) throw new ColleagueAccountError('store/colleague-accounts.json is unreadable; fix or remove it by hand', 500)
  return [...r.accounts.values()].map(publicAccount).sort((a, b) => a.username.localeCompare(b.username))
}

function writeAccounts(accounts: Map<string, ColleagueAccount>, path: string): void {
  const out: Record<string, Omit<ColleagueAccount, 'username'>> = {}
  for (const a of [...accounts.values()].sort((x, y) => x.username.localeCompare(y.username))) {
    const { username, ...rest } = a
    out[username] = rest
  }
  atomicWriteFileSync(path, `${JSON.stringify({ version: 1, accounts: out }, null, 2)}\n`, { mode: 0o600 })
  cache.delete(path)
}

/** Read for a write: a broken file is never overwritten. */
function loadForWrite(path: string): Map<string, ColleagueAccount> {
  const r = readColleagueAccounts(path)
  if (r.broken) throw new ColleagueAccountError('store/colleague-accounts.json is unreadable; fix or remove it by hand, it is not overwritten', 500)
  return new Map(r.accounts)
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Create an account. `personExists` is the caller's check against the CURRENT
 * board-access.json, so a typo in the person id is refused up front (the
 * session check repeats it on every request anyway).
 */
export async function createColleagueAccount(
  input: { username: unknown; person: unknown; password: unknown },
  personExists: (personId: string) => boolean,
  path: string = COLLEAGUE_ACCOUNTS_PATH,
): Promise<PublicColleagueAccount> {
  const username = normaliseUsername(input.username)
  if (!username) throw new ColleagueAccountError('username must be 1-64 characters: lower-case letters, digits, . _ -')
  if (typeof input.person !== 'string' || !COLLEAGUE_PERSON_RE.test(input.person)) throw new ColleagueAccountError('person must be a board-access.json person id')
  if (!personExists(input.person)) throw new ColleagueAccountError('person is not listed in store/board-access.json')
  // hashPassword enforces the owner login's password policy (PasswordPolicyError).
  const passwordHash = await hashPassword(input.password as string)
  const accounts = loadForWrite(path)
  if (accounts.has(username)) throw new ColleagueAccountError('an account with this username already exists', 409)
  const now = nowSec()
  const account: ColleagueAccount = { username, person: input.person, passwordHash, disabled: false, generation: 1, createdAt: now, updatedAt: now }
  accounts.set(username, account)
  writeAccounts(accounts, path)
  return publicAccount(account)
}

function mustGet(accounts: Map<string, ColleagueAccount>, rawUsername: unknown): ColleagueAccount {
  const username = normaliseUsername(rawUsername)
  const a = username ? accounts.get(username) : undefined
  if (!a) throw new ColleagueAccountError('no such account', 404)
  return a
}

/** New password; every open session of the account ends (generation bump). */
export async function resetColleaguePassword(rawUsername: unknown, password: unknown, path: string = COLLEAGUE_ACCOUNTS_PATH): Promise<PublicColleagueAccount> {
  mustGet(loadForWrite(path), rawUsername)
  const passwordHash = await hashPassword(password as string)
  // Re-read after the (slow) hash so a concurrent write is not lost.
  const accounts = loadForWrite(path)
  const a = mustGet(accounts, rawUsername)
  const next = { ...a, passwordHash, generation: a.generation + 1, updatedAt: nowSec() }
  accounts.set(a.username, next)
  writeAccounts(accounts, path)
  return publicAccount(next)
}

/** Disable or re-enable. Disabling ends every open session (generation bump). */
export function setColleagueDisabled(rawUsername: unknown, disabled: boolean, path: string = COLLEAGUE_ACCOUNTS_PATH): PublicColleagueAccount {
  const accounts = loadForWrite(path)
  const a = mustGet(accounts, rawUsername)
  const next = { ...a, disabled, generation: disabled ? a.generation + 1 : a.generation, updatedAt: nowSec() }
  accounts.set(a.username, next)
  writeAccounts(accounts, path)
  return publicAccount(next)
}

export function deleteColleagueAccount(rawUsername: unknown, path: string = COLLEAGUE_ACCOUNTS_PATH): void {
  const accounts = loadForWrite(path)
  const a = mustGet(accounts, rawUsername)
  accounts.delete(a.username)
  writeAccounts(accounts, path)
}

/** The account a session may still act as: present, enabled, and minted under the current generation. */
export function liveColleagueAccount(username: string, generation: number, path: string = COLLEAGUE_ACCOUNTS_PATH): ColleagueAccount | null {
  const r = readColleagueAccounts(path)
  if (r.broken) return null
  const a = r.accounts.get(username)
  if (!a || a.disabled || a.generation !== generation) return null
  return a
}

export function _clearColleagueAccountsCacheForTest(): void {
  cache.clear()
}
