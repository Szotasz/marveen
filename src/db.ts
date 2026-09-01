import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, openSync, closeSync } from 'node:fs'
import { load as loadSqliteVec } from 'sqlite-vec'
import { STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ } from './config.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { logger } from './logger.js'
import { TOOL_TIMEOUTS } from './tool-timeouts.js'
import { applyMigrations } from './db-migrations.js'
import { rerank } from './reranker.js'
import { stripMarkup } from './web/import-utils.js'

let db: Database.Database
let vecExtensionLoaded = false
let vecExtensionAttempted = false

// Lock the DB file and its sidecars (WAL, SHM, rollback journal) down to
// owner-only. better-sqlite3 opens the main file with the process umask
// (typically 0o644), which leaves a TOCTOU window where any other local
// process -- malicious npm postinstall, rogue shell script, unrelated
// tool running under the operator's UID -- can open() it for read BEFORE
// we narrow the mode. The narrowed chmod would not revoke an already-
// opened fd. Defense in depth:
//   (1) Pre-create the main DB file via openSync('wx', 0o600) so better-
//       sqlite3 inherits the tight mode on fresh installs and the race
//       window is closed entirely.
//   (2) After Database() + PRAGMA wal, chmod the sidecars (WAL/SHM/
//       journal) -- they were created during the pragma call at umask.
//       This path also fixes older installs whose files sit at 0o644.
function tightenDbPermissions(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  for (const path of sidecars) {
    if (!existsSync(path)) continue
    try { chmodSync(path, 0o600) } catch (err) {
      logger.warn({ err, path }, 'Failed to tighten DB file permissions')
    }
  }
}

// dbPathOverride is for tests: pass ':memory:' (or a temp file path) to open an
// isolated database instead of the real store/claudeclaw.db. ':memory:' has no
// path to chmod, so the file-precreate (openSync 'wx') and tightenDbPermissions
// steps are skipped for it. A real on-disk override path (e.g. a /tmp temp file)
// STILL gets pre-create + tighten -- this lets the permission tests exercise the
// tightening logic on a throwaway file instead of touching the prod DB. The
// STORE_DIR mkdir stays prod-only; a temp-file override owns its own directory.
export function initDatabase(dbPathOverride?: string): void {
  const useOverride = dbPathOverride !== undefined
  const isMemory = dbPathOverride === ':memory:'
  if (!useOverride) mkdirSync(STORE_DIR, { recursive: true })
  // Idempotent re-init: close a previous handle before opening a new one
  // so repeated calls (tests, hot-reload, recovery paths) do not leak
  // the old better-sqlite3 fd.
  if (db) {
    try { db.close() } catch { /* already closed */ }
  }
  vecExtensionLoaded = false
  vecExtensionAttempted = false
  const dbPath = useOverride ? dbPathOverride! : join(STORE_DIR, DB_FILENAME)
  // Step 1: close the TOCTOU window on fresh installs. openSync with 'wx'
  // + 0o600 creates the file ONLY if it doesn't exist and sets the strict
  // mode atomically. better-sqlite3 then opens the existing file rather
  // than creating one at the default umask. Skipped only for ':memory:'.
  if (!isMemory && !existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, 'wx', 0o600))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // EEXIST: a concurrent startup won the race and created it. The
      // tightenDbPermissions call below will correct its mode.
      if (code !== 'EEXIST') {
        logger.warn({ err, dbPath }, 'Pre-create of DB file failed, continuing; mode will be tightened post-open')
      }
    }
  }
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // Performance pragmas: safe with WAL, applied after journal_mode is set.
  // cache_size: negative value = kibibytes; -8192 → 8 MB page cache (was 64 MB).
  //   In WAL mode the page cache has minimal I/O impact; 8 MB is ample for the
  //   query mix here and saves ~56 MB RSS at idle (the memory-reduction plan P1).
  // mmap_size: memory-mapped I/O in bytes; 64 MB (was 256 MB). Still covers the
  //   typical DB size and avoids the large anonymous mapping that bloats RSS (P2).
  // synchronous = NORMAL: safe under WAL (only full-fsync skipped, not the WAL checkpoint).
  db.pragma('cache_size = -8192')
  if (!isMemory) db.pragma('mmap_size = 67108864')
  db.pragma('synchronous = NORMAL')
  // Concurrency pragmas: applied before migrations so the retry window is
  // active even during the first-run schema creation.
  //
  // busy_timeout: retry for up to 5 s on SQLITE_BUSY instead of failing
  // immediately. Covers transient write-lock contention (checkpoint, dual-
  // process on the same DB, long batch transactions).
  db.pragma('busy_timeout = 5000')
  // wal_autocheckpoint: raise from 1000 to 2000 pages (~8 MB WAL max).
  // Fewer automatic checkpoints = fewer brief exclusive-lock windows that
  // could race with concurrent writers in the k8rack dual-instance setup.
  db.pragma('wal_autocheckpoint = 2000')
  // Startup checkpoint: collapse the WAL into the main DB file so every
  // fresh start begins with a minimal WAL (currently 5.9 MB before fix).
  // TRUNCATE resets the WAL to zero bytes after all frames are written.
  // Skipped for :memory: databases (no WAL file on disk).
  if (!isMemory) db.pragma('wal_checkpoint(TRUNCATE)')
  if (!isMemory) tightenDbPermissions(dbPath)

  // Load sqlite-vec BEFORE migrations. A schema-changing migration (table
  // rebuild: create-copy-drop-rename) makes SQLite reparse the schema, which
  // validates every trigger -- including the vec0-backed memories triggers. If
  // the extension is not loaded on this connection yet, that reparse fails with
  // "no such module: vec0" and the process dies before the dashboard can start
  // (2026-08-28 outage, migration 0022). Safe no-op when the binary is missing;
  // initVecSupport() below still does the virtual-table setup.
  tryLoadVecExtension()

  // Runtime invariant: tryLoadVecExtension() must be called before any
  // migration. If this throws, someone moved the call below applyMigrations --
  // do NOT suppress this error; restore the call order above.
  if (!vecExtensionAttempted) {
    throw new Error(
      'BUG: tryLoadVecExtension() must run before applyMigrations() -- ' +
      'see 2026-08-28 outage: table-rebuild migrations trigger a full schema ' +
      'reparse that validates vec0-backed triggers before the module is loaded',
    )
  }

  applyMigrations(db)

  // INVARIANT: a row that says 'delivered' must carry a delivered_at.
  //
  // On 2026-07-27 an operator bulk-closed a 28-row backlog with raw SQL that
  // set status without a timestamp. Nothing broke loudly -- but the queue,
  // which is the only signal we have for "what actually went out", started
  // claiming that messages had been delivered when they never left. It took an
  // hour of log archaeology to work out which of them the recipients had
  // genuinely received and which they had only read out of band, and the answer
  // was recoverable that day purely by luck.
  //
  // Enforced with a trigger rather than a CHECK constraint because SQLite
  // cannot add a CHECK to an existing table without rebuilding it, and this is
  // not worth a rebuild of the message log. Self-healing rather than ABORT:
  // aborting would turn a bookkeeping slip into a failed operation for the
  // caller, and the point is to keep the RECORD honest, not to police writers.
  // The row gets a timestamp AND -- if nothing else explains it -- a marker
  // saying it was closed without ever being delivered, so the distinction
  // survives in the data instead of in someone's memory.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS agent_messages_delivered_needs_ts
    AFTER UPDATE OF status ON agent_messages
    FOR EACH ROW WHEN NEW.status = 'delivered' AND NEW.delivered_at IS NULL
    BEGIN
      UPDATE agent_messages
         SET delivered_at = CAST(strftime('%s','now') AS INTEGER),
             result = COALESCE(result, 'closed-without-delivery')
       WHERE id = NEW.id;
    END
  `)

  // One-time L1 backfill: federation system ids are now stored lowercase, but
  // rows written by a pre-L1 build (an install that federated with a
  // display-cased id like "Teodor/agent") keep their old case. Left alone,
  // thread grouping and conversation history key on the exact string and
  // silently SPLIT such a peer into two threads once new lowercase rows
  // arrive. Fold the SYSTEM prefix of qualified rows in place (the agent
  // segment keeps its case -- it is the peer's namespace). Idempotent: an
  // already-lowercase prefix compares equal and is skipped, so this is a
  // safe no-op after the first run and on fresh installs.
  db.exec(`
    UPDATE agent_messages
       SET from_agent = lower(substr(from_agent, 1, instr(from_agent, '/') - 1)) || substr(from_agent, instr(from_agent, '/'))
     WHERE instr(from_agent, '/') > 0
       AND substr(from_agent, 1, instr(from_agent, '/') - 1) <> lower(substr(from_agent, 1, instr(from_agent, '/') - 1))
  `)
  db.exec(`
    UPDATE agent_messages
       SET to_agent = lower(substr(to_agent, 1, instr(to_agent, '/') - 1)) || substr(to_agent, instr(to_agent, '/'))
     WHERE instr(to_agent, '/') > 0
       AND substr(to_agent, 1, instr(to_agent, '/') - 1) <> lower(substr(to_agent, 1, instr(to_agent, '/') - 1))
  `)


  // One-shot migration from the old JSON file (which had a read-modify-write
  // race). Import rows if they exist, then rename the file so we don't keep
  // re-importing. Wrapped in a transaction so a crash mid-import is safe.
  migrateTaskRunsFromJson()

  // Convert any remaining JSON-text embeddings to compact Float32 BLOB and null
  // out the TEXT column. Idempotent: rows already having embedding_blob are
  // skipped; on fresh installs or after a full backfill this is a no-op.
  migrateExistingEmbeddingsToBLOB()

  // Load sqlite-vec extension and set up the ANN virtual table + sync triggers.
  // Safe no-op if the extension binary is unavailable; vectorSearch falls back
  // to full-scan BLOB cosine similarity in that case.
  initVecSupport()

  // Create shadow rows in memories for any import_memories entries that lack
  // them.  Must run after initVecSupport so that vec0 is loaded and the
  // vec_memories virtual table exists before the backfill inserts into it.
  void backfillImportShadowRows().catch(err => logger.warn({ err }, 'Import shadow backfill failed'))
}

function migrateTaskRunsFromJson(): void {
  const legacyPath = join(STORE_DIR, 'task-run-history.json')
  if (!existsSync(legacyPath)) return
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM task_runs').get() as { c: number }).c
  if (existingCount > 0) {
    // Already migrated in a previous run. Rename the file out of the way if
    // still present so the migration doesn't keep re-running with zero effect.
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
    return
  }
  try {
    const raw = readFileSync(legacyPath, 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    const insert = db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)')
    const tx = db.transaction((rows: unknown[]) => {
      for (const e of rows) {
        if (!e || typeof e !== 'object') continue
        const { name, agent, ts } = e as { name?: unknown; agent?: unknown; ts?: unknown }
        if (typeof name !== 'string' || typeof agent !== 'string' || typeof ts !== 'number') continue
        insert.run(name, agent, ts)
      }
    })
    tx(arr)
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
  } catch { /* corrupt file, skip */ }
}

export function getDb(): Database.Database {
  return db
}

// --- Munkamenetek ---

export function getSession(chatId: string): { sessionId: string; messageCount: number } | undefined {
  const row = db
    .prepare('SELECT session_id, message_count FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; message_count: number } | undefined
  if (!row) return undefined
  return { sessionId: row.session_id, messageCount: row.message_count }
}

export function setSession(chatId: string, sessionId: string, messageCount = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at, message_count) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000), messageCount)
}

export function incrementSessionCount(chatId: string): number {
  db.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE chat_id = ?').run(chatId)
  const row = db.prepare('SELECT message_count FROM sessions WHERE chat_id = ?').get(chatId) as { message_count: number } | undefined
  return row?.message_count ?? 0
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Dashboard users (optional browser login) ---

export interface DashboardUser {
  id: number
  username: string
  password_hash: string
  created_at: number
  updated_at: number
  disabled: number
  role: string
  tenant_id: string | null
  email: string | null
  display_name: string | null
}

export type DashboardUserPublic = Omit<DashboardUser, 'password_hash'>

export function createDashboardUser(username: string, passwordHash: string): DashboardUser {
  const now = Math.floor(Date.now() / 1000)
  // First-user-wins bootstrap: if the table is currently empty, the first user
  // becomes the global admin (role=admin, tenant_id=NULL). All subsequent users
  // start as viewer so they can only read until an admin grants them higher access.
  const isFirst = (db.prepare('SELECT COUNT(*) AS c FROM dashboard_users').get() as { c: number }).c === 0
  const role = isFirst ? 'admin' : 'viewer'
  const tenantId = null  // NULL = global scope; tenant-scoped users are created via the admin provisioning API
  const info = db
    .prepare(
      'INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(username, passwordHash, role, tenantId, now, now)
  return { id: Number(info.lastInsertRowid), username, password_hash: passwordHash, role, tenant_id: tenantId, email: null, display_name: null, created_at: now, updated_at: now, disabled: 0 }
}

export function getDashboardUser(username: string): DashboardUser | undefined {
  return db
    .prepare('SELECT * FROM dashboard_users WHERE username = ? COLLATE NOCASE')
    .get(username) as DashboardUser | undefined
}

export function listDashboardUsers(): DashboardUserPublic[] {
  return db
    .prepare('SELECT id, username, role, tenant_id, created_at, updated_at, disabled FROM dashboard_users ORDER BY username COLLATE NOCASE')
    .all() as DashboardUserPublic[]
}

// enabled-only count feeds `login_available`; total count feeds `setup_required`.
export function countDashboardUsers(includeDisabled = false): number {
  const sql = includeDisabled
    ? 'SELECT COUNT(*) AS c FROM dashboard_users'
    : 'SELECT COUNT(*) AS c FROM dashboard_users WHERE disabled = 0'
  return (db.prepare(sql).get() as { c: number }).c
}

export function updateDashboardUserPassword(userId: number, passwordHash: string): void {
  db.prepare('UPDATE dashboard_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, Math.floor(Date.now() / 1000), userId)
}

export function deleteDashboardUser(username: string): boolean {
  const info = db.prepare('DELETE FROM dashboard_users WHERE username = ? COLLATE NOCASE').run(username)
  return info.changes > 0
}

// --- Memória ---

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  updated_at: number | null
  agent_id: string
  category: string  // 'hot' | 'warm' | 'cold' | 'shared'
  auto_generated: number
  keywords: string | null
  tenant_id?: string
  embedding: string | null
  embedding_blob: Buffer | null
}

export interface SpanRead {
  id: number
  agent_id: string
  memory_id: number
  read_at: number
  context: 'heartbeat' | 'search' | 'direct' | null
}

export interface MemoryVersion {
  id: number
  memory_id: number
  content: string
  category: string
  keywords: string | null
  changed_at: number
  changed_by: string
  change_type: 'create' | 'update' | 'category_change'
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)'
  ).run(chatId, topicKey ?? null, content, sector, now, now)
}

// Build a safe FTS5 MATCH expression from a free-form user query.
//
// FTS5 treats AND / OR / NOT / NEAR as reserved operators only when uppercase
// and unquoted -- so we lowercase everything, which turns them into ordinary
// search terms. We also cap the number and length of tokens to bound query
// cost (the sanitizer previously allowed an arbitrary-length prefix expansion
// that could make a single request scan the entire index).
export function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    // Replace punctuation with a space (not delete) so "rank-check" / "serper.dev"
    // tokenize the same way unicode61 indexed them (rank + check), instead of
    // fusing into a single unfindable token "rankcheck".
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

// -- Recency-weighted retrieval (Roitman 17.4.2) --
//
// score = λ·relevance + (1−λ)·recency, where recency = exp(−age/τ). Pure
// keyword rank returns whichever memory FTS scores highest regardless of age,
// so a stale fact ("reply tool down") can outrank its own correction ("reply
// tool up"). The blend keeps relevance dominant (λ = 0.7) but breaks
// near-ties in favour of the newer memory.
//
// FTS5 `rank` is bm25: negative, more negative = better. Normalized to 0..1
// via −rank/(1−rank) (monotonic, no unbounded tail). The blend runs in JS on
// an oversampled candidate set rather than in SQL so it does not depend on
// SQLite being compiled with math functions, and stays unit-testable.
export const RECENCY_LAMBDA = 0.7
export const RECENCY_TAU_SEC = 7 * 86400
// Candidates fetched per requested row before re-ranking. Bounded so a broad
// query still touches at most 4x the requested rows.
const RECENCY_OVERSAMPLE = 4

export interface RecencyRankable {
  rank: number
  created_at: number
}

export function recencyWeightedScore(
  row: RecencyRankable,
  nowSec: number,
  lambda = RECENCY_LAMBDA,
  tauSec = RECENCY_TAU_SEC,
): number {
  const relevance = row.rank < 0 ? -row.rank / (1 - row.rank) : 0
  const ageSec = Math.max(0, nowSec - row.created_at)
  const recency = Math.exp(-ageSec / tauSec)
  return lambda * relevance + (1 - lambda) * recency
}

export function reRankByRecency<T extends RecencyRankable>(
  rows: T[],
  limit: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): T[] {
  return rows
    .map((row) => ({ row, score: recencyWeightedScore(row, nowSec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.row)
}

// Strip the FTS rank column the oversampled queries select for re-ranking, so
// the public return shape stays exactly Memory.
function withoutRank<T extends { rank: number }>(rows: T[]): Omit<T, 'rank'>[] {
  return rows.map(({ rank: _rank, ...rest }) => rest)
}

export function searchMemories(query: string, chatId: string, limit = 3, tenantId?: string): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    const tc = tenantId ? ' AND m.tenant_id = ?' : ''
    const tp = tenantId ? [tenantId] : []
    const candidates = db
      .prepare(
        `SELECT m.*, f.rank AS rank FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE f.content MATCH ? AND m.chat_id = ?${tc}
         ORDER BY rank
         LIMIT ?`
      )
      .all(terms, chatId, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
    return withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } catch {
    return []
  }
}

export function recentMemories(chatId: string, limit = 5, tenantId?: string): Memory[] {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return db
    .prepare(`SELECT * FROM memories WHERE chat_id = ?${tc} ORDER BY accessed_at DESC LIMIT ?`)
    .all(chatId, ...tp, limit) as Memory[]
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, id)
}

// Mark a batch of memories as just-recalled (bumps accessed_at only). Used by
// the agent-memory read endpoint so that accessed_at reflects real usage --
// without this, agent memories keep accessed_at == created_at forever and any
// "not accessed in N days" staleness check (e.g. the Dream Engine hygiene pass)
// treats even freshly-recalled memories as stale. Salience is intentionally
// left untouched here; this is a lightweight recency stamp, not a ranking bump.
export function touchMemoriesAccessed(ids: number[]): void {
  if (ids.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE memories SET accessed_at = ? WHERE id IN (${placeholders})`).run(now, ...ids)
}

export function decayMemories(): void {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 86400
  // Gentler decay: 0.5% per day, only for memories older than 1 week
  // Never delete -- salience just goes lower but memories persist
  db.prepare('UPDATE memories SET salience = MAX(salience * 0.995, 0.01) WHERE created_at < ?').run(oneWeekAgo)
}

export function getMemoriesForChat(chatId: string, limit = 10, tenantId?: string): Memory[] {
  if (tenantId) {
    return db.prepare('SELECT * FROM memories WHERE chat_id = ? AND tenant_id = ? ORDER BY accessed_at DESC LIMIT ?')
      .all(chatId, tenantId, limit) as Memory[]
  }
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

// --- In-process memory cache (TTL-based) ---
//
// Avoids a SQLite round-trip on every context-fetch by keeping the most
// recently read agent memory lists in a Map for up to MEMORY_CACHE_TTL_MS.
// Any write to the memories table for a given agent evicts that agent's entry.
// The cache is intentionally coarse-grained (per agentId+limit) to stay
// simple and safe under concurrent async paths.

const MEMORY_CACHE_TTL_MS = 60_000

interface MemoryCacheEntry {
  value: Memory[]
  expiresAt: number
}

const memoryCache = new Map<string, MemoryCacheEntry>()

function memoryCacheGet(key: string): Memory[] | null {
  const entry = memoryCache.get(key)
  if (!entry || Date.now() > entry.expiresAt) {
    memoryCache.delete(key)
    return null
  }
  return entry.value
}

function memoryCacheSet(key: string, value: Memory[]): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS })
}

function memoryCacheInvalidate(agentId: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${agentId}:`)) memoryCache.delete(key)
  }
}

/** Exposed for tests and diagnostics only. */
export function clearMemoryCache(): void {
  memoryCache.clear()
}

/** Exposed for tests only. */
export function getMemoryCacheSize(): number {
  return memoryCache.size
}

export function saveAgentMemory(
  agentId: string,
  content: string,
  category: string,  // hot, warm, cold, shared
  keywords?: string,
  autoGenerated: boolean = false,
  tenantId: string = 'default',
): { id: number } {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, tenant_id) VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?)'
  ).run(ALLOWED_CHAT_ID, null, content, 'semantic', now, now, agentId, category, autoGenerated ? 1 : 0, keywords ?? null, tenantId)
  const id = Number(info.lastInsertRowid)

  if (!autoGenerated) {
    try {
      writeAgentAuditLog({ agent_id: agentId, entity: 'memory', action: 'create', entity_id: id, detail: { category, keywords: keywords ?? null } })
    } catch { /* audit failure must not abort the save */ }
  }

  // A new 'shared' row joins EVERY agent's list, not just the author's, so
  // evicting the author alone would leave every other agent serving a list
  // that is missing it. Same call the update path makes, for the same reason.
  if (category === 'shared') clearMemoryCache()
  else memoryCacheInvalidate(agentId)

  // Fire-and-forget: generate embedding, store as Float32 BLOB, then link to
  // semantically similar neighbors. All three steps are best-effort -- Ollama
  // unavailability silently skips them without affecting the saved memory.
  generateEmbedding(content + (keywords ? ' ' + keywords : '')).then(async emb => {
    if (emb) {
      const blob = floatsToBlob(emb)
      db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, id)
      syncVecMemoryEmbeddingUpdate(id, blob)
      await linkToNeighbors(id)
    }
  }).catch(() => {})

  return { id }
}

// The category filter belongs in SQL, ahead of the LIMIT. Filtering the rows
// afterwards would answer "the <category> ones among the N most recently
// accessed memories" instead of "the N most recent <category> memories", so an
// older-but-still-active memory would drop out of the list with no truncation
// signal -- invisible to the caller, and worst right after a restart.
export function getAgentMemories(agentId: string, limit: number = 20, category?: string, tenantId?: string): Memory[] {
  const key = `${agentId}:${limit}:${category ?? ''}:${tenantId ?? ''}`
  const cached = memoryCacheGet(key)
  if (cached) return cached
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const result = (category
    ? db.prepare(
        `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND category = ?${tc} ORDER BY accessed_at DESC LIMIT ?`
      ).all(agentId, category, ...tp, limit)
    : db.prepare(
        `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared')${tc} ORDER BY accessed_at DESC LIMIT ?`
      ).all(agentId, ...tp, limit)) as Memory[]
  memoryCacheSet(key, result)
  return result
}

export function searchAgentMemories(agentId: string, query: string, limit: number = 10, tenantId?: string): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  const tc = tenantId ? ' AND m.tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  try {
    const candidates = db.prepare(
      `SELECT m.*, f.rank AS rank FROM memories m
       JOIN memories_fts f ON m.id = f.rowid
       WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')${tc}
       ORDER BY rank LIMIT ?`
    ).all(terms, agentId, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
    return withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } catch {
    const tcFallback = tenantId ? ' AND tenant_id = ?' : ''
    return db.prepare(
      `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?)${tcFallback} ORDER BY accessed_at DESC LIMIT ?`
    ).all(agentId, `%${query}%`, `%${query}%`, ...tp, limit) as Memory[]
  }
}

export function getMemoryStats(): { total: number; byAgent: Record<string, number>; byTier: Record<string, number>; withEmbedding: number; importCount: number } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as {c:number}).c
  // Count both the compact binary embedding_blob (the primary store since the
  // 0005 migration) and the legacy JSON `embedding` column. Counting only the
  // legacy column reported 0 vectors after the blob migration emptied it, even
  // though every memory has a blob embedding.
  const withEmbedding = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE embedding_blob IS NOT NULL OR embedding IS NOT NULL').get() as {c:number}).c
  const agentRows = db.prepare('SELECT agent_id, COUNT(*) as c FROM memories GROUP BY agent_id').all() as {agent_id:string, c:number}[]
  const tierRows = db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as {category:string, c:number}[]
  const byAgent: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  for (const r of agentRows) byAgent[r.agent_id] = r.c
  for (const r of tierRows) byTier[r.category] = r.c
  // Import memories are stored in a separate table; include their count in the
  // summary so the dashboard can show "Ebből import: N db".
  let importCount = 0
  try {
    importCount = (db.prepare('SELECT COUNT(*) as c FROM import_memories').get() as {c:number}).c
  } catch { /* table may not exist yet if migration hasn't run */ }
  return { total, byAgent, byTier, withEmbedding, importCount }
}

export function updateMemory(
  id: number,
  content: string,
  category?: string,
  agentId?: string,
  keywords?: string,
  modifiedBy?: string,
): boolean {
  const now = Math.floor(Date.now() / 1000)

  // Read the row's CURRENT owner and category before writing. The agentId
  // parameter is optional and means "reassign to this agent", so it is absent
  // on the ordinary edit -- it cannot be used to decide whose cache went
  // stale. Only the row itself knows that.
  const before = db.prepare('SELECT agent_id, category FROM memories WHERE id = ?').get(id) as
    { agent_id: string | null; category: string | null } | undefined

  // Capture old state before the update so we can write a version record with
  // the correct changed_by (modifiedBy or agentId) without touching agent_id.
  const current = db.prepare(
    'SELECT content, category, keywords, agent_id FROM memories WHERE id = ?'
  ).get(id) as { content: string; category: string; keywords: string | null; agent_id: string } | undefined

  if (current) {
    const newCategory = category || current.category
    const newKeywords = keywords !== undefined ? keywords : current.keywords
    const contentChanged = content !== current.content
    const categoryChanged = newCategory !== current.category
    const keywordsChanged = newKeywords !== current.keywords
    if (contentChanged || categoryChanged || keywordsChanged) {
      const changeType = categoryChanged && !contentChanged ? 'category_change' : 'update'
      const changedBy = modifiedBy || agentId || current.agent_id
      db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, current.content, current.category, current.keywords, now, changedBy, changeType)
    }
  }

  const sets: string[] = ['content = ?', 'accessed_at = ?', 'updated_at = ?']
  const params: unknown[] = [content, now, now]
  if (category) { sets.push('category = ?'); params.push(category) }
  if (agentId) { sets.push('agent_id = ?'); params.push(agentId) }
  if (keywords !== undefined) { sets.push('keywords = ?'); params.push(keywords) }
  params.push(id)
  const changed = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
  if (changed) {
    const actor = modifiedBy || agentId || before?.agent_id || 'unknown'
    try {
      writeAgentAuditLog({ agent_id: actor, entity: 'memory', action: 'update', entity_id: id, detail: { category: category ?? null, keywords: keywords ?? null } })
    } catch { /* audit failure must not abort the update */ }
    if (before?.category === 'shared' || category === 'shared') {
      // A shared row is listed for every agent, so evicting one owner is not
      // enough. Same blunt call the DELETE route makes, for the same reason.
      clearMemoryCache()
    } else {
      if (before?.agent_id) memoryCacheInvalidate(before.agent_id)
      if (agentId && agentId !== before?.agent_id) memoryCacheInvalidate(agentId)
    }
  }
  return changed
}

// --- Span tracing ---

export function recordMemoryRead(
  agentId: string,
  memoryId: number,
  context: 'heartbeat' | 'search' | 'direct',
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)'
  ).run(agentId, memoryId, now, context)
}

// Record reads for a batch of memory ids in a single transaction.
export function recordMemoryReadBatch(
  agentId: string,
  memoryIds: number[],
  context: 'heartbeat' | 'search' | 'direct',
): void {
  if (memoryIds.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const stmt = db.prepare(
    'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const id of memoryIds) stmt.run(agentId, id, now, context)
  })
  tx()
}

// Returns memories that are stale for the given agent:
// updated_at > agent's last span_read.read_at (or never read at all).
export function getStaleMemories(agentId: string, tenantId?: string): Memory[] {
  const tc = tenantId ? '\n      AND m.tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return db.prepare(`
    SELECT m.* FROM memories m
    LEFT JOIN (
      SELECT memory_id, MAX(read_at) AS last_read
      FROM span_reads
      WHERE agent_id = ?
      GROUP BY memory_id
    ) sr ON sr.memory_id = m.id
    WHERE (m.agent_id = ? OR m.category = 'shared')
      AND m.updated_at > COALESCE(sr.last_read, 0)${tc}
    ORDER BY m.updated_at DESC
  `).all(agentId, agentId, ...tp) as Memory[]
}

export function getMemoryVersions(memoryId: number): MemoryVersion[] {
  return db.prepare(
    'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY changed_at DESC, id DESC'
  ).all(memoryId) as MemoryVersion[]
}

// Auto tier-resorting based on span_reads activity. All three steps run in
// a single transaction so a crash leaves the DB in a consistent state.
//
// warm -> cold: memory is at least warmToColdDays old AND has not been read
//   in the last warmToColdDays (hot is manually managed; shared is never
//   auto-archived -- both implicitly excluded by category='warm').
//   The created_at guard prevents freshly saved memories from being archived
//   immediately on their first maintenance run just because they have no reads yet.
// cold -> warm: read by 2+ distinct agents within the last coldToWarmDays.
// version prune: delete memory_versions older than 180 days.
//
// Returns affected row counts for observability.
export function runMemoryMaintenance(opts: {
  warmToColdDays?: number
  coldToWarmDays?: number
  minAgents?: number
  versionTtlDays?: number
} = {}): { warmToCold: number; coldToWarm: number; prunedVersions: number } {
  const warmToColdSecs = (opts.warmToColdDays ?? 30) * 86400
  const coldToWarmSecs = (opts.coldToWarmDays ?? 30) * 86400
  const minAgents = opts.minAgents ?? 2
  const versionCutoff = Math.floor(Date.now() / 1000) - (opts.versionTtlDays ?? 180) * 86400
  const now = Math.floor(Date.now() / 1000)

  return db.transaction(() => {
    // Only warm -> cold: hot is manually managed; shared belongs to all agents.
    // created_at check: memory must be at least warmToColdSecs old before it
    // can be auto-archived (a brand-new unread memory is not the same as a stale one).

    // Log warm->cold transitions before UPDATE so memory_versions has an audit trail.
    // SELECT candidates first (same WHERE as the UPDATE below), then bulk-insert versions.
    type CandRow = { id: number; content: string; keywords: string | null }
    const warmToColdCandidates = db.prepare(`
      SELECT id, content, keywords FROM memories
      WHERE category = 'warm'
        AND created_at < ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM span_reads
          WHERE span_reads.memory_id = memories.id
            AND span_reads.read_at > ? - ?
        )
    `).all(now, warmToColdSecs, now, warmToColdSecs) as CandRow[]

    if (warmToColdCandidates.length > 0) {
      const logV = db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)'
      )
      for (const c of warmToColdCandidates) {
        logV.run(c.id, c.content, 'cold', c.keywords, now, 'system:maintenance', 'category_change')
      }
    }

    const warmToCold = db.prepare(`
      UPDATE memories
      SET category = 'cold', updated_at = ?
      WHERE category = 'warm'
        AND created_at < ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM span_reads
          WHERE span_reads.memory_id = memories.id
            AND span_reads.read_at > ? - ?
        )
    `).run(now, now, warmToColdSecs, now, warmToColdSecs).changes

    // Log cold->warm transitions before UPDATE.
    const coldToWarmCandidates = db.prepare(`
      SELECT id, content, keywords FROM memories
      WHERE category = 'cold'
        AND id IN (
          SELECT memory_id FROM span_reads
          WHERE read_at > ? - ?
          GROUP BY memory_id
          HAVING COUNT(DISTINCT agent_id) >= ?
        )
    `).all(now, coldToWarmSecs, minAgents) as CandRow[]

    if (coldToWarmCandidates.length > 0) {
      const logV = db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)'
      )
      for (const c of coldToWarmCandidates) {
        logV.run(c.id, c.content, 'warm', c.keywords, now, 'system:maintenance', 'category_change')
      }
    }

    const coldToWarm = db.prepare(`
      UPDATE memories
      SET category = 'warm', updated_at = ?
      WHERE category = 'cold'
        AND id IN (
          SELECT memory_id FROM span_reads
          WHERE read_at > ? - ?
          GROUP BY memory_id
          HAVING COUNT(DISTINCT agent_id) >= ?
        )
    `).run(now, now, coldToWarmSecs, minAgents).changes

    const prunedVersions = db.prepare(
      'DELETE FROM memory_versions WHERE changed_at < ?'
    ).run(versionCutoff).changes

    return { warmToCold, coldToWarm, prunedVersions }
  })()
}

// Delete memory_versions entries older than ttlDays (default 180).
export function pruneMemoryVersions(ttlDays = 180): number {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return db.prepare(
    'DELETE FROM memory_versions WHERE changed_at < ?'
  ).run(cutoff).changes
}

// --- Daily logs ---

export function appendDailyLog(agentId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000)
  // Budapest calendar day, not UTC -- otherwise an entry written 00:00-02:00
  // local time lands on the previous day and the "ma" recall query misses it.
  // en-CA formats as YYYY-MM-DD.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)').run(agentId, today, content, now)
}

export function getDailyLog(agentId: string, date: string): { id: number; content: string; created_at: number }[] {
  return db.prepare('SELECT id, content, created_at FROM daily_logs WHERE agent_id = ? AND date = ? ORDER BY created_at ASC').all(agentId, date) as { id: number; content: string; created_at: number }[]
}

export function getDailyLogDates(agentId: string, limit: number = 14): string[] {
  return (db.prepare('SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?').all(agentId, limit) as { date: string }[]).map(r => r.date)
}

// --- Session Recall ---

export interface ArtifactPointer {
  id: string
  title: string
  kind: string
  created_at: number
  score: number
}

export interface RecallResult {
  logs: { id: number; agent_id: string; date: string; content: string; created_at: number }[]
  memories: Memory[]
  dateRange: { from: string; to: string }
  related_artifacts?: ArtifactPointer[]
}

function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function recallByDateRange(from: string, to: string, agentId?: string, tenantId?: string): RecallResult {
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = db.prepare(logSql).all(...logParams) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  // daily_logs has no tenant_id column (Jonas Q3 decision: no migration). Only memories are tenant-filtered.
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const memSql = agentId
    ? `SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared')${tc} ORDER BY created_at ASC`
    : `SELECT * FROM memories WHERE created_at >= ? AND created_at <= ?${tc} ORDER BY created_at ASC`
  const memParams = agentId ? [fromTs, toTs, agentId, ...tp] : [fromTs, toTs, ...tp]
  const memories = db.prepare(memSql).all(...memParams) as Memory[]

  return { logs, memories, dateRange: { from, to } }
}

export function recallSearch(query: string, agentId?: string, limit = 50, tenantId?: string): RecallResult {
  const terms = buildFtsMatchExpression(query)
  let memories: Memory[] = []
  const escaped = escapeLike(query)
  const tc = tenantId ? ' AND m.tenant_id = ?' : ''
  const tcFb = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (terms) {
    try {
      // Was ORDER BY created_at DESC (pure recency, relevance ignored); now the
      // same λ-blend as the other search paths, so a strongly matching older
      // memory can still surface above barely-matching fresh noise.
      const sql = agentId
        ? `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')${tc} ORDER BY rank LIMIT ?`
        : `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ?${tc} ORDER BY rank LIMIT ?`
      const candidates = agentId
        ? db.prepare(sql).all(terms, agentId, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
        : db.prepare(sql).all(terms, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
      memories = withoutRank(reRankByRecency(candidates, limit)) as Memory[]
    } catch {
      const sql = agentId
        ? `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')${tcFb} ORDER BY created_at DESC LIMIT ?`
        : `SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')${tcFb} ORDER BY created_at DESC LIMIT ?`
      const pat = `%${escaped}%`
      memories = agentId
        ? db.prepare(sql).all(agentId, pat, pat, ...tp, limit) as Memory[]
        : db.prepare(sql).all(pat, pat, ...tp, limit) as Memory[]
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? db.prepare(logSql).all(logPat, agentId, limit) as RecallResult['logs']
    : db.prepare(logSql).all(logPat, limit) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories, dateRange: { from, to } }
}

// --- Background tasks ---

export interface BackgroundTask {
  id: string
  agent_id: string
  prompt: string
  status: 'running' | 'done' | 'failed' | 'timeout'
  tmux_session: string | null
  started_at: number
  finished_at: number | null
  output: string | null
}

export function createBackgroundTaskAtomic(id: string, agentId: string, prompt: string, tmuxSession: string, maxConcurrent: number): BackgroundTask | null {
  const now = Math.floor(Date.now() / 1000)
  const result = db.transaction(() => {
    const running = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
    if (running >= maxConcurrent) return null
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, agentId, prompt, 'running', tmuxSession, now)
    return { id, agent_id: agentId, prompt, status: 'running' as const, tmux_session: tmuxSession, started_at: now, finished_at: null, output: null }
  })()
  return result
}

export function getRunningBackgroundTasks(): BackgroundTask[] {
  return db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all() as BackgroundTask[]
}

export function finishBackgroundTask(id: string, status: 'done' | 'failed' | 'timeout', output: string | null): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
    .run(status, now, output, id)
}

export function getBackgroundTasks(agentId?: string, includeFinished = false): BackgroundTask[] {
  if (agentId) {
    const sql = includeFinished
      ? 'SELECT * FROM background_tasks WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50'
      : "SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC"
    return db.prepare(sql).all(agentId) as BackgroundTask[]
  }
  const sql = includeFinished
    ? 'SELECT * FROM background_tasks ORDER BY started_at DESC LIMIT 50'
    : "SELECT * FROM background_tasks WHERE status = 'running' ORDER BY started_at DESC"
  return db.prepare(sql).all() as BackgroundTask[]
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTask | undefined
}

export function countRunningBackgroundTasks(agentId: string): number {
  return (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
}

export function markOrphanedTasksFailed(): number {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'")
    .run(now)
  return info.changes
}

// --- Ütemezett feladatok ---

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  db.prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?")
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?'
  ).run(now, nextRun, result, id)
}

export function listTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id).changes > 0
  )
}

export function resumeTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id).changes > 0
  )
}

export function getTask(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined
}

export function updateTask(id: string, prompt: string, schedule: string, nextRun: number): boolean {
  return db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule = ?, next_run = ? WHERE id = ?').run(prompt, schedule, nextRun, id).changes > 0
}

// --- Kanban ---

export interface KanbanCard {
  id: string
  // Stable running number derived from the SQLite rowid (insertion order, never
  // reused) -- a human-friendly "#N" shown next to the 8-char hex id.
  seq?: number
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'waiting' | 'testing' | 'done'
  assignee: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  project: string | null
  parent_id: string | null
  // Denormalized depth in the card tree: 0 = top-level, 1 = subtask, 2 = sub-subtask.
  // Maintained by createKanbanCard, updateKanbanCard, and reparentKanbanCard.
  // Max allowed depth is 2 (enforced at application layer).
  depth: number
  due_date: number | null
  sort_order: number
  created_at: number
  updated_at: number
  archived_at: number | null
  // Set the first time the card is moved to in_progress and the assigned agent
  // is woken (kanban -> agent dispatch). NULL = never dispatched; the once-only
  // guard so re-dragging a card does not re-prompt the agent.
  dispatched_at: number | null
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

export function listKanbanCards(): KanbanCard[] {
  const archiveDays = Number(getEffectiveSettingValue('KANBAN_ARCHIVE_DONE_DAYS'))
  const archiveCutoff = Math.floor(Date.now() / 1000) - archiveDays * 86400
  // Auto-archive done cards older than KANBAN_ARCHIVE_DONE_DAYS days
  db.prepare(
    "UPDATE kanban_cards SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?"
  ).run(Math.floor(Date.now() / 1000), archiveCutoff)
  return db
    .prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NULL ORDER BY sort_order ASC')
    .all() as KanbanCard[]
}

export function listKanbanCardsSummary(): { status: string; title: string; assignee: string | null; priority: string; id: string }[] {
  return db
    .prepare("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
    .all() as any[]
}

export function getKanbanCard(id: string): KanbanCard | undefined {
  return db.prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined
}

export function createKanbanCard(card: {
  id: string
  title: string
  description?: string
  status?: KanbanCard['status']
  assignee?: string
  priority?: KanbanCard['priority']
  project?: string
  parent_id?: string
  due_date?: number
  tenant_id?: string
}): void {
  const now = Math.floor(Date.now() / 1000)
  const status = card.status ?? 'planned'

  // Compute depth from parent; enforce max 2 (3 levels: 0, 1, 2).
  let depth = 0
  if (card.parent_id) {
    const parent = getKanbanCard(card.parent_id)
    if (!parent) throw new Error(`Parent card not found: ${card.parent_id}`)
    depth = parent.depth + 1
    if (depth > 2) throw new Error('Cannot create card: exceeds max depth of 3 levels')
  }

  const maxRow = db.prepare(
    'SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL'
  ).get(status) as { m: number | null }
  const sortOrder = (maxRow?.m ?? -1) + 1

  db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, depth, due_date, sort_order, created_at, updated_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id, card.title, card.description ?? null, status,
    card.assignee ?? null, card.priority ?? 'normal',
    card.project ?? null, card.parent_id ?? null, depth, card.due_date ?? null, sortOrder, now, now,
    card.tenant_id ?? 'default',
  )
  try {
    writeAgentAuditLog({ agent_id: card.assignee || 'system', entity: 'kanban', action: 'create', entity_id: card.id, detail: { title: card.title, status, priority: card.priority ?? 'normal' } })
  } catch { /* audit failure must not abort card creation */ }
}

export function updateKanbanCard(id: string, fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>): boolean {
  const card = getKanbanCard(id)
  if (!card) return false
  const now = Math.floor(Date.now() / 1000)

  // When parent_id changes, recompute depth and validate the constraint.
  let newDepth = card.depth
  const parentChanging = 'parent_id' in fields && fields.parent_id !== card.parent_id
  if (parentChanging) {
    if (fields.parent_id) {
      const newParent = getKanbanCard(fields.parent_id)
      if (!newParent) return false
      newDepth = newParent.depth + 1
      // Ensure no descendant would exceed depth 2 after the move.
      if (newDepth + getSubtreeHeight(id) > 2) return false
    } else {
      newDepth = 0
    }
  }

  const f = { ...card, ...fields, depth: newDepth, updated_at: now }
  const ok = db.prepare(
    `UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, depth=?, due_date=?, sort_order=?, updated_at=?, archived_at=?
     WHERE id=?`
  ).run(f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.depth, f.due_date, f.sort_order, f.updated_at, f.archived_at, id).changes > 0

  if (ok) {
    if (parentChanging) cascadeDepth(id, newDepth)
    try {
      writeAgentAuditLog({ agent_id: f.assignee || 'system', entity: 'kanban', action: 'update', entity_id: id, detail: { status: f.status, priority: f.priority } })
    } catch { /* audit failure must not abort card update */ }
  }
  return ok
}

export function getChildCards(parentId: string): KanbanCard[] {
  return db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC').all(parentId) as KanbanCard[]
}

// Recursively update the depth of all descendants of parentId.
// Called after any parent_id change so the denormalized depth stays consistent.
function cascadeDepth(parentId: string, parentDepth: number): void {
  const children = db.prepare('SELECT id FROM kanban_cards WHERE parent_id = ?').all(parentId) as { id: string }[]
  for (const child of children) {
    db.prepare('UPDATE kanban_cards SET depth = ? WHERE id = ?').run(parentDepth + 1, child.id)
    cascadeDepth(child.id, parentDepth + 1)
  }
}

// Returns the full subtree rooted at cardId (including the root card itself),
// ordered by depth then sort_order. Archived descendants are excluded.
export function getSubtree(cardId: string): KanbanCard[] {
  return db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM kanban_cards WHERE id = ?
      UNION ALL
      SELECT c.id FROM kanban_cards c JOIN subtree s ON c.parent_id = s.id
    )
    SELECT rowid AS seq, kc.* FROM kanban_cards kc
    WHERE kc.id IN (SELECT id FROM subtree) AND kc.archived_at IS NULL
    ORDER BY kc.depth ASC, kc.sort_order ASC
  `).all(cardId) as KanbanCard[]
}

// Returns the height of the subtree rooted at cardId: 0 means the card is a
// leaf, 1 means it has children but no grandchildren, 2 means it has grandchildren.
// Used to validate depth constraints when reparenting.
export function getSubtreeHeight(cardId: string): number {
  const children = db.prepare(
    'SELECT id FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL'
  ).all(cardId) as { id: string }[]
  if (children.length === 0) return 0
  return 1 + Math.max(...children.map(c => getSubtreeHeight(c.id)))
}

// Reparent a card to a new parent (or to top-level when newParentId is null).
// Validates the depth constraint: target.depth + 1 + subtreeHeight(id) <= 2.
// Cascades depth to all descendants and triggers status propagation on both
// the old and new parent.
export function reparentKanbanCard(
  id: string, newParentId: string | null,
): { ok: true } | { ok: false; code: 'not_found' | 'invalid_value' | 'limit_exceeded'; hint: string } {
  const card = getKanbanCard(id)
  if (!card) return { ok: false, code: 'not_found', hint: 'Card not found' }
  if (newParentId === id) return { ok: false, code: 'invalid_value', hint: 'Card cannot be its own parent' }

  let newDepth = 0
  if (newParentId) {
    const newParent = getKanbanCard(newParentId)
    if (!newParent) return { ok: false, code: 'not_found', hint: 'Parent card not found' }
    newDepth = newParent.depth + 1
    const sh = getSubtreeHeight(id)
    if (newDepth + sh > 2) return { ok: false, code: 'limit_exceeded', hint: 'Reparenting would exceed max depth of 3 levels' }
  } else {
    const sh = getSubtreeHeight(id)
    if (sh > 2) return { ok: false, code: 'limit_exceeded', hint: 'Subtree too deep to move to top-level (descendants would exceed depth 2)' }
  }

  const oldParentId = card.parent_id
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    db.prepare('UPDATE kanban_cards SET parent_id=?, depth=?, updated_at=? WHERE id=?').run(newParentId, newDepth, now, id)
    cascadeDepth(id, newDepth)
  })()

  if (oldParentId) propagateStatusForParent(oldParentId)
  if (newParentId) propagateStatusForParent(newParentId)

  return { ok: true }
}

// Re-evaluates a parent card's status based on its children and auto-updates
// if needed, then bubbles up to the grandparent. Rules:
//   - All children done AND parent not done -> auto-set parent to done.
//   - Some children not done AND parent is done -> auto-revert to in_progress.
//   - Manual status changes override: this only fires on child status events.
function propagateStatusForParent(parentId: string): void {
  const parent = getKanbanCard(parentId)
  if (!parent || parent.archived_at) return
  const children = getChildCards(parentId)
  if (children.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const allDone = children.every(c => c.status === 'done')
  if (allDone && parent.status !== 'done') {
    const prev = parent.status
    db.prepare("UPDATE kanban_cards SET status='done', updated_at=? WHERE id=?").run(now, parent.id)
    db.prepare("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, 'done', 'auto', ?)").run(parent.id, prev, now)
    if (parent.parent_id) propagateStatusForParent(parent.parent_id)
  } else if (!allDone && parent.status === 'done') {
    const prev = parent.status
    db.prepare("UPDATE kanban_cards SET status='in_progress', updated_at=? WHERE id=?").run(now, parent.id)
    db.prepare("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, 'in_progress', 'auto', ?)").run(parent.id, prev, now)
    if (parent.parent_id) propagateStatusForParent(parent.parent_id)
  }
}

// Called from route handlers after a card's status changes so the parent
// hierarchy is kept consistent automatically.
export function propagateStatus(cardId: string): void {
  const card = getKanbanCard(cardId)
  if (!card || !card.parent_id) return
  propagateStatusForParent(card.parent_id)
}

export function moveKanbanCard(
  id: string,
  status: KanbanCard['status'],
  sortOrder: number,
  actor?: string,
  orderedIds?: string[]
): boolean {
  const now = Math.floor(Date.now() / 1000)
  // Read the previous status first so we only record an audit event on a real
  // status transition (not a pure sort_order reorder within the same column).
  const prev = (db.prepare('SELECT status FROM kanban_cards WHERE id=?').get(id) as { status: string } | undefined)?.status

  if (orderedIds && orderedIds.length > 0) {
    // Transactional renumber: status update + full column sort_order renumber in
    // one shot so every card in the target column gets a clean 0..N sequence.
    // Only the moved card's updated_at changes (sort_order is presentation-only).
    let changed = false
    db.transaction(() => {
      changed = db.prepare(
        'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
      ).run(status, orderedIds.indexOf(id), now, id).changes > 0
      if (changed && prev !== undefined && prev !== status) {
        db.prepare(
          'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(id, prev, status, actor ?? null, now)
      }
      const updateOrder = db.prepare('UPDATE kanban_cards SET sort_order=? WHERE id=?')
      orderedIds.forEach((cardId, i) => updateOrder.run(i, cardId))
    })()
    return changed
  }

  // Legacy path: single-card sort_order update (used by schedule-runner and
  // callers that don't supply the full column order).
  const changed = db.prepare(
    'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
  ).run(status, sortOrder, now, id).changes > 0
  if (changed && prev !== undefined && prev !== status) {
    db.prepare(
      'INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, prev, status, actor ?? null, now)
  }
  return changed
}

// Stamp the once-only kanban -> agent dispatch guard. Returns false if the
// card id does not exist.
export function markKanbanCardDispatched(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(now, id).changes > 0
}

export function archiveKanbanCard(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id).changes > 0
}

export function unarchiveKanbanCard(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET archived_at=NULL, updated_at=? WHERE id=? AND archived_at IS NOT NULL').run(now, id).changes > 0
}

export interface ArchivedKanbanCard {
  id: string
  title: string
  status: string
  project: string | null
  priority: string
  assignee: string | null
  archived_at: number
  updated_at: number
}

export function listArchivedKanbanCards(opts: {
  q?: string
  project?: string
  label?: string
  from?: number
  to?: number
  limit: number
}): ArchivedKanbanCard[] {
  const { q, project, label, from, to, limit } = opts
  let sql = `
    SELECT DISTINCT kc.id, kc.title, kc.status, kc.project, kc.priority, kc.assignee, kc.archived_at, kc.updated_at
    FROM kanban_cards kc
  `
  const params: unknown[] = []
  if (label) {
    sql += `
      JOIN kanban_card_labels kcl ON kcl.card_id = kc.id
      JOIN labels l ON l.id = kcl.label_id AND l.name = ?
    `
    params.push(label)
  }
  sql += ' WHERE kc.archived_at IS NOT NULL'
  if (project) { sql += ' AND kc.project = ?'; params.push(project) }
  if (from)    { sql += ' AND kc.archived_at >= ?'; params.push(from) }
  if (to)      { sql += ' AND kc.archived_at <= ?'; params.push(to) }
  if (q) {
    sql += ' AND (kc.title LIKE ? OR kc.project LIKE ? OR kc.assignee LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like)
  }
  sql += ' ORDER BY kc.archived_at DESC LIMIT ?'
  params.push(limit)
  return db.prepare(sql).all(...params) as ArchivedKanbanCard[]
}

export function listKanbanProjects(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT project FROM kanban_cards WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project"
  ).all() as Array<{ project: string }>
  return rows.map(r => r.project)
}

export function deleteKanbanCard(id: string): boolean {
  // Wrapped in a transaction to ensure atomicity. Steps in FK-safe order:
  //   1. Delete comments referencing this card (FK: kanban_comments.card_id).
  //   2. Delete this card's label associations (FK: kanban_card_labels.card_id).
  //   3. Promote children to the deleted card's parent (grandparent adoption):
  //      if the deleted card has a parent, its children inherit that parent
  //      and get depth = grandparent.depth + 1; if the deleted card is
  //      top-level, children become top-level (parent_id = NULL, depth = 0).
  //      Grandchildren are depth-cascaded accordingly.
  //   4. Delete the card itself.
  const card = getKanbanCard(id)
  if (!card) return false
  const grandparentId = card.parent_id
  const grandparentDepth = grandparentId ? (getKanbanCard(grandparentId)?.depth ?? 0) : -1
  const now = Math.floor(Date.now() / 1000)

  return db.transaction(() => {
    db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(id)
    db.prepare('DELETE FROM kanban_card_labels WHERE card_id = ?').run(id)
    const children = db.prepare('SELECT id FROM kanban_cards WHERE parent_id = ?').all(id) as { id: string }[]
    for (const child of children) {
      const newChildDepth = grandparentDepth + 1  // -1+1=0 when grandparent is null
      db.prepare('UPDATE kanban_cards SET parent_id=?, depth=?, updated_at=? WHERE id=?').run(
        grandparentId, newChildDepth, now, child.id
      )
      cascadeDepth(child.id, newChildDepth)
    }
    const deleted = db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id).changes > 0
    if (deleted) {
      try {
        writeAgentAuditLog({ agent_id: card.assignee || 'system', entity: 'kanban', action: 'delete', entity_id: id, detail: { title: card.title } })
      } catch { /* audit failure must not abort card deletion */ }
    }
    return deleted
  })() as boolean
}

export function getKanbanComments(cardId: string): KanbanComment[] {
  return db.prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as KanbanComment[]
}

export interface KanbanCardEvent {
  id: number
  card_id: string
  from_status: string | null
  to_status: string
  actor: string | null
  created_at: number
}

export function getKanbanCardEvents(cardId: string): KanbanCardEvent[] {
  return db.prepare('SELECT * FROM kanban_card_events WHERE card_id = ? ORDER BY created_at ASC, id ASC').all(cardId) as KanbanCardEvent[]
}

// Lookup a kanban card's `seq` (its sqlite rowid) by the 8-char hex id stored
// in `kanban_cards.id`. Used by the kanban-ref normalizer to rewrite hex
// references to the human-facing `#<seq>` form. Returns null when the prefix
// matches zero rows OR more than one row (ambiguous → leave the message
// untouched rather than guess). Case-insensitive: breakdown subtask ids are
// uppercased while createKanbanCard ids stay lowercase.
export function getKanbanSeqByIdPrefix(prefix: string): number | null {
  const rows = db.prepare(
    'SELECT rowid AS seq FROM kanban_cards WHERE id = ? COLLATE NOCASE LIMIT 2'
  ).all(prefix) as { seq: number }[]
  if (rows.length !== 1) return null
  return rows[0].seq
}

// Find an active (non-archived) kanban card by exact title match, or
// undefined when none exists.
export function findActiveKanbanCardByTitle(title: string): KanbanCard | undefined {
  return db.prepare(
    'SELECT rowid AS seq, * FROM kanban_cards WHERE title = ? AND archived_at IS NULL LIMIT 1'
  ).get(title) as KanbanCard | undefined
}

// Move the first active kanban card whose title equals `taskName` to the
// 'waiting' status, appending it at the end of the waiting column.
// Returns the card id when a match was found and updated, null otherwise.
// Used by the scheduled-task fire-timeout watchdog when alerting about a
// potentially stuck task.
export function markScheduledTaskKanbanWaiting(taskName: string): string | null {
  const card = findActiveKanbanCardByTitle(taskName)
  if (!card) return null
  const maxResult = db.prepare(
    "SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = 'waiting' AND archived_at IS NULL"
  ).get() as { m: number | null }
  const sortOrder = (maxResult.m ?? 0) + 100
  moveKanbanCard(card.id, 'waiting', sortOrder, 'scheduler')
  return card.id
}

export function addKanbanComment(cardId: string, author: string, content: string): KanbanComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(cardId, author, content, now)
  db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now, cardId)
  return { id: Number(info.lastInsertRowid), card_id: cardId, author, content, created_at: now }
}

// --- Kanban labels (tags) ---

export interface Label {
  id: string
  name: string
  color: string
  created_at: number
}

export function listLabels(): Label[] {
  return db.prepare('SELECT * FROM labels ORDER BY name ASC').all() as Label[]
}

export function getLabel(id: string): Label | undefined {
  return db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Label | undefined
}

export function createLabel(label: { id: string; name: string; color: string }): Label {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)'
  ).run(label.id, label.name, label.color, now)
  return { ...label, created_at: now }
}

export function updateLabel(id: string, fields: Partial<Pick<Label, 'name' | 'color'>>): boolean {
  const label = getLabel(id)
  if (!label) return false
  const f = { ...label, ...fields }
  return db.prepare('UPDATE labels SET name=?, color=? WHERE id=?').run(f.name, f.color, id).changes > 0
}

export function deleteLabel(id: string): boolean {
  // Transaction: drop every card<->label link before the label row itself,
  // otherwise the join table keeps dangling references to a label that no
  // longer exists (FK enforcement is off by default, but the orphan rows
  // would still silently resurrect a "deleted" label in card detail views).
  return db.transaction((labelId: string) => {
    db.prepare('DELETE FROM kanban_card_labels WHERE label_id = ?').run(labelId)
    return db.prepare('DELETE FROM labels WHERE id = ?').run(labelId).changes > 0
  })(id) as boolean
}

export function addLabelToCard(cardId: string, labelId: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT OR IGNORE INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)'
  ).run(cardId, labelId, now)
}

export function removeLabelFromCard(cardId: string, labelId: string): boolean {
  return db.prepare(
    'DELETE FROM kanban_card_labels WHERE card_id = ? AND label_id = ?'
  ).run(cardId, labelId).changes > 0
}

export function getLabelsForCard(cardId: string): Label[] {
  return db.prepare(`
    SELECT l.* FROM labels l
    JOIN kanban_card_labels cl ON cl.label_id = l.id
    WHERE cl.card_id = ?
    ORDER BY l.name ASC
  `).all(cardId) as Label[]
}

// Bulk variant for the board list view -- one JOIN query instead of an N+1
// per-card lookup when rendering footer pills for every card at once.
export function getLabelsForAllCards(): Map<string, Label[]> {
  const rows = db.prepare(`
    SELECT cl.card_id AS card_id, l.id AS id, l.name AS name, l.color AS color, l.created_at AS created_at
    FROM kanban_card_labels cl
    JOIN labels l ON l.id = cl.label_id
    ORDER BY l.name ASC
  `).all() as Array<Label & { card_id: string }>
  const map = new Map<string, Label[]>()
  for (const row of rows) {
    const { card_id, ...label } = row
    const list = map.get(card_id)
    if (list) list.push(label)
    else map.set(card_id, [label])
  }
  return map
}

// --- Heartbeat helpers ---

export interface HeartbeatKanbanSummary {
  urgent: KanbanCard[]
  in_progress: KanbanCard[]
  waiting: KanbanCard[]
}

/**
 * The ONE definition of "what the heartbeat lists". Both consumers read it from
 * here: the built-in heartbeat prompt (heartbeat.ts) and the heartbeat AGENT,
 * which gets it over /api/kanban/heartbeat-summary instead of composing its own
 * query. Two hand-written copies of the same filter is how they drift apart.
 *
 * `urgent` means urgent and NOT FINISHED: priority='urgent', not archived, not
 * `done`. `planned` stays IN on purpose -- "urgent and nobody has touched it" is
 * one of the states most worth seeing, and a list that hides it would be quiet
 * for the wrong reason. (A first draft of this change narrowed it to
 * waiting/in_progress; that was withdrawn precisely because it would have hidden
 * untouched urgent work.)
 *
 * What DID have to go is closed work: on 2026-08-04 the 09:00 report listed five
 * items of which three were already `done`, and the 08-03 count was 22 done
 * against 2 waiting -- the most prominent line of an hourly report was mostly
 * finished cards, so it stopped being read. Those 22 were only reachable through
 * a hand-written query; this statement never returned them, which is why the real
 * fix is that the heartbeat agent no longer writes its own query.
 */
/** Exported so a test can execute the SHIPPED statement against a fixture DB
 *  instead of re-typing an equivalent one and proving nothing. */
export const HEARTBEAT_URGENT_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'"
export const HEARTBEAT_IN_PROGRESS_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'"
export const HEARTBEAT_WAITING_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'"

// HBKANBANDRIFT819 follow-up: the heartbeat report format asks for a planned
// line, so the number needs a sanctioned server-side source like every other
// count -- without it the agent manufactures the value (measured: planned: 0
// reported against a real 305). COUNT only: no card list is served for
// planned, the line is a bare number.
export const HEARTBEAT_PLANNED_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM kanban_cards WHERE archived_at IS NULL AND status = 'planned'"

export function countPlannedKanbanCards(): number {
  const row = db.prepare(HEARTBEAT_PLANNED_COUNT_SQL).get() as { n: number } | undefined
  return row?.n ?? 0
}

export function getHeartbeatKanbanSummary(): HeartbeatKanbanSummary {
  const urgent = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'")
    .all() as KanbanCard[]
  const in_progress = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'")
    .all() as KanbanCard[]
  const waiting = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'")
    .all() as KanbanCard[]
  return { urgent, in_progress, waiting }
}

/**
 * HBMEMBLIND819: the heartbeat's "new hot memories (1h)" number is computed
 * HERE, server-side, and served over /api/kanban/heartbeat-summary -- the
 * heartbeat agent copies it like the kanban counts, it never runs the query.
 *
 * This is the SECOND failure of the prescribe-the-query pattern for this
 * metric. HBMEMBLIND807 (2026-08-07): the agent composed its own SQL and
 * reported 0 beside three hot memories; the fix prescribed a ready-made query
 * with "do not rewrite the query". HBMEMBLIND819 (2026-08-19): measured
 * 14/14 rounds reporting 0 over 24h with real values of 2 in three of them --
 * the agent ran the prescribed query SHAPE but with agent_id='heartbeat'
 * substituted for the main agent's id. Timeline over 8 sessions / 196 runs:
 * the identity rewrite appears on post-compact rounds (the agent reconstructs
 * the query from memory as "count MY hot memories" instead of re-reading the
 * prescription) and then persists as its own precedent. A prescription the
 * measured party must re-copy every round is not a mechanism; the kanban
 * counts on the SAME agent never drifted, because an endpoint number has no
 * query to rewrite. Same closure as getHeartbeatKanbanSummary above.
 */
/** Exported so a test can execute the SHIPPED statement against a fixture DB
 *  instead of re-typing an equivalent one and proving nothing. */
export const HEARTBEAT_NEW_HOT_MEMORIES_SQL =
  "SELECT COUNT(*) AS n FROM memories WHERE agent_id = ? AND category = 'hot' AND created_at > unixepoch() - 3600"

export function countNewHotMemories(agentId: string): number {
  const row = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get(agentId) as { n: number } | undefined
  return row?.n ?? 0
}

// --- Agent Messages ---

export interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed'
  result: string | null
  created_at: number
  delivered_at: number | null
  completed_at: number | null
  // Card 06f062e4: optional, self-declared attributability tag (e.g. a
  // sub-agent's own task/branch name) -- NOT an authentication mechanism,
  // see the table-creation comment. Null for every caller that doesn't pass one.
  origin_note: string | null
  // Card def5a189: distributed trace context (message-router middleware).
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
  tenant_id: string | null
}

export function createAgentMessage(
  from: string,
  to: string,
  content: string,
  originNote?: string | null,
  traceCtx?: { trace_id: string; span_id: string; parent_span_id: string | null } | null,
  tenantId: string = 'default',
): AgentMessage {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, origin_note, trace_id, span_id, parent_span_id, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(from, to, content, 'pending', now, originNote ?? null, traceCtx?.trace_id ?? null, traceCtx?.span_id ?? null, traceCtx?.parent_span_id ?? null, tenantId)
  const id = Number(info.lastInsertRowid)
  try {
    writeAgentAuditLog({ agent_id: from, entity: 'message', action: 'create', entity_id: id, detail: { to, preview: content.slice(0, 80) } })
  } catch { /* audit failure must not abort message creation */ }
  return {
    id,
    from_agent: from, to_agent: to, content, status: 'pending',
    result: null, created_at: now, delivered_at: null, completed_at: null,
    origin_note: originNote ?? null,
    trace_id: traceCtx?.trace_id ?? null,
    span_id: traceCtx?.span_id ?? null,
    parent_span_id: traceCtx?.parent_span_id ?? null,
    tenant_id: tenantId ?? null,
  }
}

export function getPendingMessages(toAgent?: string, tenantId?: string): AgentMessage[] {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (toAgent) {
    return db.prepare(`SELECT * FROM agent_messages WHERE status = 'pending' AND to_agent = ?${tc} ORDER BY created_at ASC`)
      .all(toAgent, ...tp) as AgentMessage[]
  }
  return db.prepare(`SELECT * FROM agent_messages WHERE status = 'pending'${tc} ORDER BY created_at ASC`)
    .all(...tp) as AgentMessage[]
}

// Status-guarded (pending only): the federation removal path bulk-fails
// pending rows CONCURRENTLY with an in-flight bridge send -- an unguarded
// UPDATE would flip such a row failed->delivered after the fact. If the row
// is no longer pending, this returns false and the caller must not record a
// result either.
export function markMessageDelivered(id: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'").run(now, id).changes > 0
}

// Per-agent backlog: how many messages are waiting, and how old the oldest one
// is. The queue only surfaces when somebody opens a pane and notices, which is
// how an 18-row backlog went unseen on 2026-07-27 and got mistaken for data
// loss. Age matters more than count: three messages from a minute ago is a busy
// agent working normally, one message from two hours ago is an agent that is
// never going to pick it up.
export type AgentBacklog = { agent: string; pending: number; oldestAgeSeconds: number }

export function getPendingBacklogByAgent(): AgentBacklog[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `SELECT to_agent AS agent, COUNT(*) AS pending, MIN(created_at) AS oldest
       FROM agent_messages
      WHERE status = 'pending'
      GROUP BY to_agent`,
  ).all() as { agent: string; pending: number; oldest: number }[]
  return rows
    .map(r => ({ agent: r.agent, pending: r.pending, oldestAgeSeconds: Math.max(0, now - r.oldest) }))
    // oldest-first: whoever has been waiting longest is the one worth looking at
    .sort((a, b) => b.oldestAgeSeconds - a.oldestAgeSeconds)
}

// Close a pending backlog that is NOT going to be delivered -- stale rows an
// operator does not want the router to replay (an old thank-you note, a legal
// warning whose content has since changed). Separate from markMessageDelivered
// because the two mean opposite things: one records that a message went out,
// this one records that it never will. Both leave a timestamp, and this one
// leaves a reason, so the log can still answer "was this actually delivered?"
// afterwards. Without it the only way to clear a backlog is raw SQL, which is
// how the queue got 24 rows claiming delivery they never had.
export function closeMessagesWithoutDelivery(ids: number[], reason: string): number {
  if (!ids.length) return 0
  const now = Math.floor(Date.now() / 1000)
  const note = `closed-without-delivery: ${reason}`
  const stmt = db.prepare(
    `UPDATE agent_messages SET status = 'delivered', delivered_at = ?, result = ?
      WHERE id = ? AND status = 'pending'`,
  )
  const run = db.transaction((rows: number[]) => {
    let n = 0
    for (const id of rows) n += stmt.run(now, note, id).changes
    return n
  })
  return run(ids)
}

// Supplementary result text WITHOUT a status change. The federation bridge
// records the peer-assigned id on delivered rows ("fed:<peer>:<remote id>")
// so a cross-system message can be traced without a schema migration.
export function setMessageResult(id: number, result: string): boolean {
  return db.prepare('UPDATE agent_messages SET result = ? WHERE id = ?').run(result, id).changes > 0
}

// Bulk-fail PENDING federated (slash-qualified to_agent) messages -- the
// deterministic counterpart of the bridge's drip-fail on disable/removal.
// ONE statement (claimPendingForAgent idiom: no SELECT-then-UPDATE window).
// pending only: delivered/done/failed rows are conversation history.
// Per-peer scoping compares the exact prefix segment via instr/substr -- a
// LIKE pattern would treat '_' in a peer id as a wildcard ('te_dor' purging
// 'teodor'). lower() on both sides: system ids are case-insensitive, and rows
// written before the lowercase normalization may carry an uppercase prefix
// that must still be purged with its peer (ASCII-only lower() is fine -- the
// id charset is [a-zA-Z0-9_-]).
export function failPendingFederatedMessages(peerId: string | undefined, reason: string): number[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = peerId === undefined
    ? db.prepare(
        `UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND instr(to_agent, '/') > 0
         RETURNING id`,
      ).all(reason, now) as Array<{ id: number }>
    : db.prepare(
        `UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND instr(to_agent, '/') > 0
             AND lower(substr(to_agent, 1, instr(to_agent, '/') - 1)) = lower(?)
         RETURNING id`,
      ).all(reason, now, peerId) as Array<{ id: number }>
  return rows.map((r) => r.id)
}

// Atomically CLAIM (pending -> delivered) the oldest `limit` pending messages
// for an agent, returning the claimed rows. A SINGLE `UPDATE ... WHERE
// status='pending' RETURNING` (NOT a SELECT-then-UPDATE) so two concurrent
// drains can never double-claim the same message (-> no ghost double-delivery).
// Backs the main-agent inbox PULL model: the main agent drains its own inbox at
// each turn (via the drain-inbox endpoint + UserPromptSubmit hook) instead of
// the router tmux-injecting into its perpetually-busy channel session.
export function claimPendingForAgent(toAgent: string, limit: number): AgentMessage[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `UPDATE agent_messages SET status = 'delivered', delivered_at = ?
       WHERE id IN (
         SELECT id FROM agent_messages
         WHERE to_agent = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )
     RETURNING id, from_agent, to_agent, content, status, result, created_at, delivered_at, completed_at`,
  ).all(now, toAgent, limit) as AgentMessage[]
  // RETURNING row order is unspecified; restore FIFO (created_at, then id as the
  // tiebreaker for same-second inserts) for delivery.
  return rows.sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
}

export function markMessageDone(id: number, result?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  // COALESCE: some done-transitions skip the delivered step entirely (e.g. a
  // still-pending row marked done directly via PUT), so backfill delivered_at
  // only when it was never set -- don't clobber a real earlier delivery time.
  return db.prepare("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?").run(result ?? null, now, now, id).changes > 0
}

export function markMessageFailed(id: number, error?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ?").run(error ?? null, now, id).changes > 0
}

// Status-guarded fail for the federation bridge's terminal branches: it must
// only fire (and only bounce a failure notice) when THIS call actually closed
// a still-pending row. The unguarded markMessageFailed above would also
// "succeed" on a row a concurrent disable/removal purge already failed
// (result/completed_at change -> changes>0), producing a spurious second
// notice. The drain-inbox path deliberately keeps the unguarded variant (it
// fails an already-delivered row).
export function markPendingFederatedFailed(id: number, error: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ? AND status = 'pending'").run(error, now, id).changes > 0
}

export function listAgentMessages(limit = 50, tenantId?: string): AgentMessage[] {
  if (tenantId) {
    return db.prepare('SELECT * FROM agent_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as AgentMessage[]
  }
  return db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) as AgentMessage[]
}

// --- Context-restart gate helpers -------------------------------------------

export interface DispatchedPendingStats {
  /** Count of messages sent by fromAgent with status pending|delivered, within staleCutoffMs. */
  count: number
  /** Any messages sent by fromAgent that WOULD have blocked but are beyond staleCutoffMs. */
  hasStale: boolean
}

/**
 * Check how many outbound messages this agent dispatched that have not yet
 * received a result (status pending or delivered), separating live (within
 * staleCutoffMs) from stale (beyond it). Used by the context-restart gate.
 */
export function getDispatchedPendingStats(
  fromAgent: string,
  nowMs: number,
  staleCutoffMs: number,
): DispatchedPendingStats {
  const cutoffEpoch = Math.floor((nowMs - staleCutoffMs) / 1000)
  const liveRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE from_agent = ? AND status IN ('pending','delivered')
         AND CAST(created_at AS INTEGER) > ?`,
  ).get(fromAgent, cutoffEpoch) as { cnt: number }
  const staleRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE from_agent = ? AND status IN ('pending','delivered')
         AND CAST(created_at AS INTEGER) <= ?`,
  ).get(fromAgent, cutoffEpoch) as { cnt: number }
  return {
    count:    liveRow?.cnt ?? 0,
    hasStale: (staleRow?.cnt ?? 0) > 0,
  }
}

/**
 * True when the agent's last inbound channel message has no later outbound
 * (unanswered question). Used by the context-restart gate.
 */
export function hasOpenInboundQuestion(agentId: string): boolean {
  const row = db.prepare(
    `SELECT id, created_at FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(agentId) as { id: number; created_at: number } | undefined
  if (!row) return false
  const laterOut = db.prepare(
    `SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`,
  ).get(agentId, row.created_at, row.created_at, row.id)
  return !laterOut
}

// System/automation participants that are not real conversation peers. They are
// excluded as THREAD rows in the dashboard sidebar (you don't chat with the
// heartbeat or the coordinator), but messages involving them still count toward
// the human/agent peer they are paired with (so a thread's count matches what
// getAgentConversation returns when you open it).
export const CHAT_SYSTEM_AGENTS = ['heartbeat', 'telegram-coordinator', 'channel-coordinator', 'system'] as const

const AGENT_MESSAGE_LIMIT_CAP = 200

// The actual last-N messages for ONE agent, filtered in SQL (NOT global-last-N
// then JS-filter -- that starved rarely-active agents' threads, dashboard bug
// 2026-06-03). `beforeId` pages older: pass the oldest id you already have to
// fetch the next-older batch (scroll-up pagination). Newest-first.
export function getAgentConversation(agent: string, limit = 50, beforeId?: number, tenantId?: string): AgentMessage[] {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 1), AGENT_MESSAGE_LIMIT_CAP)
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (beforeId !== undefined && Number.isFinite(beforeId)) {
    return db.prepare(
      `SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND id < ?${tc} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(agent, agent, beforeId, ...tp, cap) as AgentMessage[]
  }
  return db.prepare(
    `SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?)${tc} ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(agent, agent, ...tp, cap) as AgentMessage[]
}

export interface AgentThread {
  agent: string
  count: number
  lastMessage: AgentMessage | null
}

// One row per distinct conversation peer (from_agent OR to_agent), excluding
// CHAT_SYSTEM_AGENTS, each with its total message count and its most-recent
// message. Drives the dashboard sidebar. Recency is computed per-peer (max
// created_at) so a rarely-active peer's last message is never hidden behind the
// global recency window (the bug the JS-filter path had). Sorted newest-first.
export function getAgentConversationThreads(tenantId?: string): AgentThread[] {
  const tc = tenantId ? ' WHERE tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const countTc = tenantId ? ' AND m.tenant_id = ?' : ''
  const parties = db.prepare(`
    WITH parties AS (
      SELECT from_agent AS agent FROM agent_messages${tc}
      UNION
      SELECT to_agent AS agent FROM agent_messages${tc}
    )
    SELECT p.agent AS agent,
      (SELECT COUNT(*) FROM agent_messages m WHERE (m.from_agent = p.agent OR m.to_agent = p.agent)${countTc}) AS count
    FROM parties p
  `).all(...tp, ...tp, ...tp) as { agent: string; count: number }[]

  const lastStmt = tenantId
    ? db.prepare('SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    : db.prepare('SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC, id DESC LIMIT 1')

  const system = new Set<string>(CHAT_SYSTEM_AGENTS)
  const threads: AgentThread[] = []
  for (const p of parties) {
    if (!p.agent || system.has(p.agent)) continue
    const lastMessage = (tenantId
      ? lastStmt.get(p.agent, p.agent, tenantId)
      : lastStmt.get(p.agent, p.agent)) as AgentMessage | undefined ?? null
    threads.push({ agent: p.agent, count: p.count, lastMessage })
  }
  threads.sort((a, b) => {
    const ca = a.lastMessage?.created_at ?? 0
    const cb = b.lastMessage?.created_at ?? 0
    if (cb !== ca) return cb - ca
    return (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0) // tiebreak: newest id first
  })
  return threads
}

// --- Task Run History ---

export interface TaskRunEntry { name: string; agent: string; ts: number; status: string }

export interface TaskRunHistoryEntry { ts: number; status: string; tokens_est: number | null }

const TASK_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function appendTaskRun(name: string, agent: string, status = 'fired'): void {
  const now = Date.now()
  db.prepare('INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, ?)').run(name, agent, now, status)
  // Opportunistic TTL prune: cheap indexed DELETE, keeps the table bounded.
  db.prepare('DELETE FROM task_runs WHERE ts < ?').run(now - TASK_RUN_TTL_MS)
}

export function listTaskRunHistory(name: string, limit: number): TaskRunHistoryEntry[] {
  const rows = db.prepare(
    'SELECT ts, status, agent FROM task_runs WHERE name = ? ORDER BY ts DESC LIMIT ?'
  ).all(name, limit) as { ts: number; status: string; agent: string }[]

  // token_usage.timestamp is in seconds; task_runs.ts is in ms -- divide by 1000
  const tokenStmt = db.prepare(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens), 0) as total
     FROM token_usage WHERE agent = ? AND timestamp >= ? AND timestamp < ?`
  )

  // Rows are DESC (newest first). For each run, approximate token usage as
  // the sum for that agent in the window [ts, next_newer_ts) capped at 1 hour.
  return rows.map((row, i) => {
    const newerTs = i > 0 ? rows[i - 1].ts : undefined
    const windowEnd = newerTs !== undefined ? Math.min(row.ts + 3600000, newerTs) : row.ts + 3600000
    const tokenRow = tokenStmt.get(row.agent, Math.floor(row.ts / 1000), Math.floor(windowEnd / 1000)) as { total: number }
    return { ts: row.ts, status: row.status, tokens_est: tokenRow.total > 0 ? tokenRow.total : null }
  })
}

export function countTaskRunsBetween(fromTs: number, toTs?: number): number {
  if (toTs === undefined) {
    const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ?').get(fromTs) as { c: number }
    return row.c
  }
  const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ? AND ts < ?').get(fromTs, toTs) as { c: number }
  return row.c
}

export function getAgentMessage(id: number): AgentMessage | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage | undefined
}

export function getActiveScheduledTaskCount(): { count: number; nextRun: number | null } {
  const row = db
    .prepare("SELECT COUNT(*) as count, MIN(next_run) as next_run FROM scheduled_tasks WHERE status = 'active'")
    .get() as { count: number; next_run: number | null }
  return { count: row.count, nextRun: row.next_run }
}

// --- Pending scheduled-task retries ------------------------------------

export interface PendingTaskRetryRow {
  id: number
  task_name: string
  agent_name: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  last_reason: string | null
  alert_sent_at: number | null
}

/**
 * Insert a busy-skipped scheduled task into the retry queue if and only if
 * no row exists for the (task_name, agent_name) pair. Returns true on
 * insert, false if a row already existed. Used for the first "busy" hit
 * from the cron loop.
 */
export function insertPendingTaskRetryIfNew(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(taskName, agentName, now, now, reason).changes > 0
}

/**
 * Update an existing retry row's last_attempt / attempt_count / last_reason.
 * Returns true if a row was updated, false if none existed (e.g. the
 * operator cancelled the row between a tick loading it and this call).
 * Used from the retry loop so a cancelled row isn't silently re-created.
 */
export function updatePendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    UPDATE pending_task_retries
       SET last_attempt = ?,
           attempt_count = attempt_count + 1,
           last_reason = ?
     WHERE task_name = ? AND agent_name = ?
  `).run(now, reason, taskName, agentName).changes > 0
}

/** Back-compat shim used by tests written against the original upsert
 * semantics. Internal code should use the explicit insert-if-new /
 * update-if-exists pair above. */
export function upsertPendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): void {
  if (!updatePendingTaskRetry(taskName, agentName, now, reason)) {
    insertPendingTaskRetryIfNew(taskName, agentName, now, reason)
  }
}

/** Clear the alert timestamp so the next tick is free to re-alert. Used
 * when a Telegram send failed after we stamped the row optimistically. */
export function clearPendingTaskRetryAlert(taskName: string, agentName: string): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = NULL WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function listPendingTaskRetries(): PendingTaskRetryRow[] {
  return db
    .prepare('SELECT * FROM pending_task_retries ORDER BY first_attempt ASC')
    .all() as PendingTaskRetryRow[]
}

export function getPendingTaskRetry(taskName: string, agentName: string): PendingTaskRetryRow | undefined {
  return db
    .prepare('SELECT * FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .get(taskName, agentName) as PendingTaskRetryRow | undefined
}

export function deletePendingTaskRetry(taskName: string, agentName: string): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function deletePendingTaskRetryById(id: number): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE id = ?')
    .run(id).changes > 0
}

export function markPendingTaskRetryAlert(taskName: string, agentName: string, ts: number): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = ? WHERE task_name = ? AND agent_name = ? AND alert_sent_at IS NULL')
    .run(ts, taskName, agentName).changes > 0
}

// --- Vector Search (Ollama + nomic-embed-text) ---

const EMBED_MODEL = 'nomic-embed-text'

// Encode a float32 array as a little-endian binary buffer (4 bytes per value).
function floatsToBlob(floats: number[]): Buffer {
  const buf = Buffer.allocUnsafe(floats.length * 4)
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4)
  return buf
}

// Decode a Float32 BLOB back to a number array.
function blobToFloats(blob: Buffer): number[] {
  const count = blob.byteLength >>> 2
  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) out[i] = blob.readFloatLE(i * 4)
  return out
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['ollama-embedding']),
    })
    const data = await resp.json() as { embedding?: number[] }
    return data.embedding || null
  } catch (err) {
    // Debug-level so it doesn't spam default INFO logs when Ollama isn't
    // running (the common case on most user machines). Enables "why does
    // hybrid search only return FTS results?" diagnostics without noise.
    logger.debug({ err, ollamaUrl: OLLAMA_URL }, 'Embedding generation failed (Ollama not running?)')
    return null
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Over-fetch factor for cross-encoder reranking: retrieve N*RERANK_FACTOR
// candidates from ANN/cosine, then let the reranker pick the best N.
const RERANK_FACTOR = 5

// Recency decay for vector search: score = base * exp(-lambda * age_days).
// Half-life = ln(2)/0.02 ≈ 35 days. Distinct from the FTS reRankByRecency
// blend (which operates on BM25 rank, not cosine/ANN scores) -- no overlap.
const VECTOR_RECENCY_LAMBDA = 0.02

function vectorRecencyDecay(createdAt: number, nowSec: number): number {
  const ageDays = (nowSec - createdAt) / 86400
  return Math.exp(-VECTOR_RECENCY_LAMBDA * ageDays)
}

async function vectorSearch(
  agentId: string,
  queryEmbedding: number[],
  limit: number = 10,
  crossAgent: boolean = false,
  tenantId?: string
): Promise<Memory[]> {
  let candidates: Memory[] = []
  const nowSec = Math.floor(Date.now() / 1000)
  // Tenant clause applied to non-crossAgent paths only. crossAgent is the
  // graph link-building path (linkToNeighbors) which intentionally crosses
  // agent and tenant boundaries to build the structural knowledge graph.
  const tc = (!crossAgent && tenantId) ? ' AND tenant_id = ?' : ''
  const tp = (!crossAgent && tenantId) ? [tenantId] : []

  // crossAgent skips ANN entirely: the vec_memories index may have orphan rows
  // (entries whose backing memories row was deleted or never backfilled), so an
  // ANN hit set is unreliable for cross-fleet searches. BLOB full-scan is the
  // safe path because it reads directly from the source of truth.
  if (vecExtensionLoaded && !crossAgent) {
    try {
      // ANN path: over-fetch by RERANK_FACTOR to give the reranker headroom.
      const queryBlob = floatsToBlob(queryEmbedding)
      // k must be SQLITE_INTEGER; JS numbers bind as SQLITE_FLOAT in better-sqlite3.
      const annRows = db.prepare(`
        SELECT memory_id, distance
        FROM vec_memories
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `).all(queryBlob, BigInt(limit * RERANK_FACTOR)) as { memory_id: number; distance: number }[]

      if (annRows.length > 0) {
        const ids = annRows.map(r => r.memory_id)
        const placeholders = ids.map(() => '?').join(',')
        const memories = db.prepare(
          `SELECT * FROM memories WHERE id IN (${placeholders}) AND (agent_id = ? OR category = 'shared')${tc}`
        ).all([...ids, agentId, ...tp]) as Memory[]

        const distMap = new Map(annRows.map(r => [r.memory_id, r.distance]))
        // Pipeline step 2: recency boost -- reorder by (proximity * decay) so
        // the cross-encoder sees fresher candidates first within the same
        // similarity tier. Uses 1/(1+distance) as an ANN proximity proxy.
        memories.sort((a, b) => {
          const sA = (1 / (1 + (distMap.get(a.id) ?? Infinity))) * vectorRecencyDecay(a.created_at, nowSec)
          const sB = (1 / (1 + (distMap.get(b.id) ?? Infinity))) * vectorRecencyDecay(b.created_at, nowSec)
          return sB - sA
        })
        candidates = memories
      }
    } catch (err) {
      logger.debug({ err }, 'ANN search failed, falling back to BLOB cosine similarity')
    }
  }

  if (candidates.length === 0) {
    // BLOB cosine fallback: full-scan. Recall ranks by cosine * recency decay;
    // crossAgent (link-building) ranks by pure cosine -- see the scoring note below.
    // crossAgent: skip agent_id/shared filter (same reason as ANN path above).
    const rows = crossAgent
      ? (db.prepare("SELECT * FROM memories WHERE embedding_blob IS NOT NULL OR embedding IS NOT NULL").all() as Memory[])
      : (db.prepare(`SELECT * FROM memories WHERE (embedding_blob IS NOT NULL OR embedding IS NOT NULL) AND (agent_id = ? OR category = 'shared')${tc}`).all(agentId, ...tp) as Memory[])

    const scored = rows.map(m => {
      try {
        const emb: number[] = m.embedding_blob
          ? blobToFloats(m.embedding_blob as Buffer)
          : JSON.parse(m.embedding!) as number[]
        const sim = cosineSimilarity(queryEmbedding, emb)
        // crossAgent is the graph link-building path (linkToNeighbors): rank by
        // pure similarity. The recency decay is a recall-time bias meant to
        // surface fresh memories in search; applying it here suppresses older
        // but genuinely-similar neighbors, which is exactly wrong when wiring the
        // structural graph. Symptom it fixes: a batch of freshly imported docs
        // (decay ~1.0) crowds every neighbor slot with other fresh imports, so
        // established agent memories (decay <1) never get linked even when their
        // cosine is well above the threshold -- imports end up connected only to
        // each other. Recall (crossAgent=false) keeps the recency weighting.
        return { memory: m, score: crossAgent ? sim : sim * vectorRecencyDecay(m.created_at, nowSec) }
      } catch {
        return { memory: m, score: 0 }
      }
    })

    scored.sort((a, b) => b.score - a.score)
    candidates = scored.slice(0, limit * RERANK_FACTOR).map(s => s.memory)
  }

  return candidates.slice(0, limit)
}

// Decay applied to 1-hop neighbor scores added during graph traversal.
// Keeps linked memories visible without letting them outrank direct hits.
const LINK_TRAVERSAL_DECAY = 0.5

export async function hybridSearch(agentId: string, query: string, limit: number = 10, tenantId?: string): Promise<Memory[]> {
  const k = 60 // RRF constant

  // FTS5 results
  const ftsResults = searchAgentMemories(agentId, query, limit * 2, tenantId)

  // Vector results
  const queryEmbedding = await generateEmbedding(query)
  const vecResults = queryEmbedding ? await vectorSearch(agentId, queryEmbedding, limit * 2, false, tenantId) : []

  // Reciprocal Rank Fusion
  const scores: Map<number, number> = new Map()
  const byId: Map<number, Memory> = new Map()

  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  vecResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  // 1-hop graph traversal: expand the top-ranked hits by their linked neighbors.
  // Neighbors receive a decayed fraction of the source memory's RRF score so
  // they surface as contextual context without displacing direct hits.
  const topIds = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
  for (const srcId of topIds) {
    const srcScore = scores.get(srcId) ?? 0
    const neighbors = getMemoryNeighbors(srcId, 5)
    for (const { memory, weight } of neighbors) {
      if (byId.has(memory.id)) continue  // already in result set, don't double-add
      const neighborScore = srcScore * weight * LINK_TRAVERSAL_DECAY
      scores.set(memory.id, (scores.get(memory.id) || 0) + neighborScore)
      byId.set(memory.id, memory)
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])

  // Pipeline step 3: cross-encoder reranker applied to the fused RRF list so
  // the final order seen by callers reflects semantic relevance, not just
  // BM25+cosine rank fusion. Only when flag is ON (default OFF).
  if (getEffectiveSettingValue('MEMORY_RERANK_ENABLED') === '1') {
    const fusedList = ranked.slice(0, limit * RERANK_FACTOR).map(([id]) => byId.get(id)!)
    if (fusedList.length > 0) {
      try {
        return await rerank(query, fusedList, { topK: limit })
      } catch (err) {
        logger.debug({ err }, 'hybridSearch: reranker threw unexpectedly, returning RRF order')
        return fusedList.slice(0, limit)
      }
    }
  }

  return ranked.slice(0, limit).map(([id]) => byId.get(id)!)
}

export async function backfillEmbeddings(): Promise<number> {
  const rows = db.prepare('SELECT id, content, keywords FROM memories WHERE embedding_blob IS NULL').all() as { id: number; content: string; keywords: string | null }[]
  let count = 0
  for (const row of rows) {
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    const emb = await generateEmbedding(text)
    if (emb) {
      const blob = floatsToBlob(emb)
      db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, row.id)
      syncVecMemoryEmbeddingUpdate(row.id, blob)
      count++
    }
    // Small delay to not overwhelm Ollama
    await new Promise(r => setTimeout(r, 100))
  }
  return count
}

// ── Import shadow row backfill ────────────────────────────────────────────────

// Creates shadow rows in `memories` for any `import_memories` entry that lacks
// one (memory_shadow_id IS NULL).  Called after initVecSupport() so that vec0
// is loaded when the application-level vec sync (syncVecMemoryEmbeddingUpdate)
// runs during embedding backfill.
export async function backfillImportShadowRows(): Promise<number> {
  type ImportRow = { id: string; content: string; keywords: string | null; updated_at: number }
  const pending = db
    .prepare('SELECT id, content, keywords, updated_at FROM import_memories WHERE memory_shadow_id IS NULL')
    .all() as ImportRow[]
  if (pending.length === 0) return 0

  for (const row of pending) {
    const result = db
      .prepare(
        `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at)
         VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?) RETURNING id`,
      )
      .get(row.content, row.keywords, row.updated_at, row.updated_at, row.updated_at) as { id: number }
    db.prepare('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?').run(result.id, row.id)
  }

  logger.info({ count: pending.length }, 'Backfilled import shadow rows')

  // Strip raw HTML/markup from any previously-crawled HTML import rows.
  // New crawls already strip via import-crawler.ts; this one-time pass cleans
  // rows ingested before that fix.  Runs here (after initVecSupport) so that
  // vec0 is loaded when the application-level vec sync runs on the
  // embedding_blob UPDATE inside the loop below.
  type HtmlImportRow = { import_id: string; content: string; shadow_id: number }
  const htmlRows = db
    .prepare(
      `SELECT im.id AS import_id, im.content, m.id AS shadow_id
       FROM import_memories im
       JOIN memories m ON m.id = im.memory_shadow_id
       WHERE (im.file_name LIKE '%.html' OR im.file_name LIKE '%.htm'
           OR im.file_name LIKE '%.xml'  OR im.file_name LIKE '%.svg')
         AND im.content LIKE '<%'`,
    )
    .all() as HtmlImportRow[]

  if (htmlRows.length > 0) {
    for (const row of htmlRows) {
      const stripped = stripMarkup(row.content)
      db.prepare('UPDATE import_memories SET content = ? WHERE id = ?').run(stripped, row.import_id)
      db.prepare('UPDATE memories SET content = ?, embedding_blob = NULL WHERE id = ?').run(stripped, row.shadow_id)
    }
    logger.info({ count: htmlRows.length }, 'Stripped HTML markup from existing import shadow rows')
  }

  void runLinkMaintenance({ maxAge: 86400 * 30 }).catch(err =>
    logger.warn({ err }, 'Link maintenance after import shadow backfill failed'),
  )
  return pending.length
}

// ── Memory links (F1/F2/F3 semantic graph) ───────────────────────────────────

export interface MemoryLink {
  id: number
  src_id: number
  dst_id: number
  link_type: 'semantic' | 'explicit' | 'entity' | 'cooccurrence'
  weight: number
  created_at: number
  last_traversed_at: number | null
}

/**
 * Upsert a directed link between two memories. If (src, dst, type) already
 * exists the weight is replaced with the new value (INSERT OR REPLACE).
 * Returns the row id of the upserted link.
 */
export function upsertMemoryLink(
  srcId: number,
  dstId: number,
  linkType: MemoryLink['link_type'],
  weight: number,
): number {
  const stmt = db.prepare(
    `INSERT INTO memory_links (src_id, dst_id, link_type, weight)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(src_id, dst_id, link_type) DO UPDATE SET weight = excluded.weight, last_traversed_at = unixepoch()`
  )
  const result = stmt.run(srcId, dstId, linkType, weight) as { lastInsertRowid: number | bigint }
  return Number(result.lastInsertRowid)
}

/**
 * Return the 1-hop neighbors reachable from srcId, ordered by weight desc.
 * Updates last_traversed_at on the traversed edges.
 */
export function getMemoryNeighbors(srcId: number, limit = 10): { memory: Memory; weight: number }[] {
  // Touch traversal timestamp
  db.prepare('UPDATE memory_links SET last_traversed_at = unixepoch() WHERE src_id = ?').run(srcId)

  const rows = db.prepare(
    `SELECT m.*, ml.weight
     FROM memory_links ml
     JOIN memories m ON m.id = ml.dst_id
     WHERE ml.src_id = ?
     ORDER BY ml.weight DESC
     LIMIT ?`
  ).all(srcId, limit) as (Memory & { weight: number })[]

  return rows.map(r => ({ memory: r, weight: r.weight }))
}

/**
 * Delete links whose weight has decayed below threshold or whose endpoints
 * no longer exist. Returns the count of removed links.
 */
/**
 * Return all memory_links where either endpoint is in the given id set.
 * Used by the dashboard graph to fetch edges for a loaded set of memories.
 */
export function getLinksForMemories(ids: number[]): MemoryLink[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM memory_links
     WHERE src_id IN (${placeholders}) OR dst_id IN (${placeholders})
     ORDER BY weight DESC`
  ).all(...ids, ...ids) as MemoryLink[]
}

export function pruneMemoryLinks(weightThreshold = 0.1): number {
  const result = db.prepare(
    `DELETE FROM memory_links WHERE weight < ?`
  ).run(weightThreshold) as { changes: number }
  return result.changes
}

/**
 * Create semantic links from a newly saved memory to its top-N cosine
 * neighbors. Skips if no embedding available. Returns link count created.
 */
export async function linkToNeighbors(memoryId: number, maxNeighbors = 5, similarityThreshold = 0.75): Promise<number> {
  const row = db.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(memoryId) as { embedding_blob: Buffer | null } | undefined
  if (!row?.embedding_blob) return 0

  const agentRow = db.prepare('SELECT agent_id FROM memories WHERE id = ?').get(memoryId) as { agent_id: string | null } | undefined
  if (!agentRow?.agent_id) return 0

  const queryVec = blobToFloats(row.embedding_blob)
  // Import shadow rows (agent_id='import') must search the full fleet so they
  // can link against memories from all agents, not only other import rows.
  const crossAgent = agentRow.agent_id === 'import'
  // Import nodes have lower average cosine similarity (~0.66-0.70) because they
  // are crawled documents, not agent-authored memories. Use a lower threshold so
  // edges actually form. Regular agent memories keep the caller-supplied default.
  const effectiveThreshold = crossAgent ? Math.min(similarityThreshold, 0.65) : similarityThreshold
  const candidates = await vectorSearch(agentRow.agent_id, queryVec, maxNeighbors + 1, crossAgent)

  let linked = 0
  for (const candidate of candidates) {
    if (candidate.id === memoryId) continue
    const candBlob = db.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(candidate.id) as { embedding_blob: Buffer | null } | undefined
    if (!candBlob?.embedding_blob) continue
    const sim = cosineSimilarity(queryVec, blobToFloats(candBlob.embedding_blob))
    if (sim < effectiveThreshold) continue
    upsertMemoryLink(memoryId, candidate.id, 'semantic', sim)
    linked++
    if (linked >= maxNeighbors) break
  }
  return linked
}

export interface LinkMaintenanceResult {
  reembedded: number
  linksCreated: number
  linksPruned: number
  orphans: number
}

/**
 * Periodic maintenance for the memory link graph:
 * 1. Re-embed memories whose updated_at > last link created_at (stale embeddings).
 * 2. Create/refresh neighbor links for recently updated memories.
 * 3. Prune links below weightThreshold.
 * 4. Count orphan memories: have embedding but 0 outgoing links.
 *
 * Designed to run as a heartbeat scheduled task (e.g. nightly). All steps
 * are best-effort -- Ollama unavailability yields reembedded=0.
 */
export async function runLinkMaintenance(opts: {
  weightThreshold?: number
  maxAge?: number   // seconds: only re-link memories updated within this window
} = {}): Promise<LinkMaintenanceResult> {
  const { weightThreshold = 0.1, maxAge = 7 * 86400 } = opts
  const cutoff = Math.floor(Date.now() / 1000) - maxAge

  // Step 1: backfill embeddings for memories updated recently that lack one
  const needsEmbed = db.prepare(
    `SELECT id, content, keywords FROM memories
     WHERE embedding_blob IS NULL AND updated_at >= ?`
  ).all(cutoff) as { id: number; content: string; keywords: string | null }[]

  let reembedded = 0
  for (const row of needsEmbed) {
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    const emb = await generateEmbedding(text)
    if (emb) {
      const blob = floatsToBlob(emb)
      db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, row.id)
      syncVecMemoryEmbeddingUpdate(row.id, blob)
      reembedded++
    }
  }

  // Step 2: re-link memories with embedding updated recently
  const toLink = db.prepare(
    `SELECT id FROM memories WHERE embedding_blob IS NOT NULL AND updated_at >= ?`
  ).all(cutoff) as { id: number }[]

  let linksCreated = 0
  for (const { id } of toLink) {
    linksCreated += await linkToNeighbors(id)
  }

  // Step 3: prune decayed links
  const linksPruned = pruneMemoryLinks(weightThreshold)

  // Step 4: count orphans (have embedding, 0 outgoing semantic links)
  const orphanRow = db.prepare(
    `SELECT COUNT(*) AS c FROM memories
     WHERE embedding_blob IS NOT NULL
       AND id NOT IN (SELECT DISTINCT src_id FROM memory_links WHERE link_type = 'semantic')`
  ).get() as { c: number }
  const orphans = orphanRow.c

  logger.info({ reembedded, linksCreated, linksPruned, orphans }, 'Link maintenance complete')
  return { reembedded, linksCreated, linksPruned, orphans }
}

/**
 * One-time migration: convert any existing JSON-text embeddings to Float32 BLOB
 * and immediately null out the TEXT column to reclaim space. Runs synchronously
 * inside a single transaction so it is safe to call at startup after migrations.
 */
export function migrateExistingEmbeddingsToBLOB(): number {
  const rows = db.prepare(
    'SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND embedding_blob IS NULL'
  ).all() as { id: number; embedding: string }[]

  if (rows.length === 0) return 0

  const update = db.prepare('UPDATE memories SET embedding_blob = ?, embedding = NULL WHERE id = ?')
  const tx = db.transaction((items: { id: number; embedding: string }[]) => {
    let converted = 0
    for (const row of items) {
      try {
        const floats = JSON.parse(row.embedding) as number[]
        update.run(floatsToBlob(floats), row.id)
        converted++
      } catch {
        // Malformed JSON: leave the row untouched; it will be regenerated by backfillEmbeddings.
      }
    }
    return converted
  })

  const count = tx(rows) as number
  logger.info({ converted: count }, 'Migrated JSON embeddings to Float32 BLOB')
  return count
}

// Application-level vec_memories synchronisation helpers.
//
// These replace the three DROP'd triggers (vec_memories_ai/au/ad). Call them
// wherever the application writes to `memories` so the ANN index stays in sync
// without requiring vec0 to be loaded on every database connection.
export function syncVecMemoryDelete(id: number): void {
  if (!vecExtensionLoaded) return
  try {
    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id))
  } catch { /* vec0 unavailable at runtime -- no-op */ }
}

export function syncVecMemoryEmbeddingUpdate(id: number, embeddingBlob: Buffer): void {
  if (!vecExtensionLoaded) return
  try {
    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id))
    db.prepare('INSERT OR IGNORE INTO vec_memories(memory_id, embedding) VALUES(?, ?)').run(BigInt(id), embeddingBlob)
  } catch { /* vec0 unavailable at runtime -- no-op */ }
}

function tryLoadVecExtension(): void {
  vecExtensionAttempted = true
  try {
    loadSqliteVec(db)
    vecExtensionLoaded = true
  } catch {
    logger.debug('sqlite-vec extension unavailable, using BLOB cosine similarity fallback')
  }
}

function initVecSupport(): void {
  // Drop any leftover sync triggers first so stale triggers never fire against
  // a missing virtual table (e.g. when the extension failed to load this run).
  db.exec(`
    DROP TRIGGER IF EXISTS vec_memories_ai;
    DROP TRIGGER IF EXISTS vec_memories_au;
    DROP TRIGGER IF EXISTS vec_memories_ad;
  `)

  tryLoadVecExtension()
  if (!vecExtensionLoaded) return

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      memory_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )
  `)

  // Backfill: push any existing BLOB embeddings not yet in the ANN index.
  const pending = db.prepare(
    'SELECT id, embedding_blob FROM memories WHERE embedding_blob IS NOT NULL AND id NOT IN (SELECT memory_id FROM vec_memories)'
  ).all() as { id: number; embedding_blob: Buffer }[]

  if (pending.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO vec_memories(memory_id, embedding) VALUES(?, ?)')
    const tx = db.transaction(() => {
      // better-sqlite3 binds JS numbers as SQLITE_FLOAT; vec0 INTEGER PRIMARY KEY
      // requires SQLITE_INTEGER. BigInt forces the correct SQLite type.
      for (const row of pending) insert.run(BigInt(row.id), row.embedding_blob)
    })
    tx()
    logger.info({ count: pending.length }, 'Backfilled existing embeddings into vec_memories ANN index')
  }

  // vec_artifacts: ANN index for artifact title+meta embeddings (pointer-only recall).
  // INSERT/UPDATE are handled async in artifacts-db.ts (fire-and-forget).
  // DELETE trigger keeps the index clean when an artifact is removed.
  db.exec(`
    DROP TRIGGER IF EXISTS vec_artifacts_ad;
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifacts USING vec0(
      artifact_rowid INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )
  `)

  db.exec(`
    CREATE TRIGGER vec_artifacts_ad
    AFTER DELETE ON artifacts
    BEGIN
      DELETE FROM vec_artifacts WHERE artifact_rowid = OLD.rowid;
    END
  `)

  // vec_workspace_docs: ANN index for workspace document embeddings.
  // App-level sync only (no triggers) -- insert/delete handled in workspace-store.ts.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_workspace_docs USING vec0(
      doc_id      TEXT     PRIMARY KEY,
      agent_id    TEXT     PARTITION KEY,
      tenant_id   TEXT,
      embedding   float[768]
    )
  `)
}

// --- Artifact Vector Search ---

/**
 * Search artifacts by semantic similarity against their title+meta embeddings.
 * Returns ArtifactPointer list (no content) sorted by similarity score.
 * Returns empty array when sqlite-vec is unavailable or Ollama is unreachable.
 */
export async function searchArtifactsByVector(
  query: string,
  limit = 10
): Promise<ArtifactPointer[]> {
  if (!vecExtensionLoaded) return []
  const queryEmbedding = await generateEmbedding(query)
  if (!queryEmbedding) return []

  try {
    const queryBlob = floatsToBlob(queryEmbedding)
    const annRows = db.prepare(`
      SELECT artifact_rowid, distance
      FROM vec_artifacts
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `).all(queryBlob, BigInt(limit)) as { artifact_rowid: number; distance: number }[]

    if (annRows.length === 0) return []

    const rowids = annRows.map(r => r.artifact_rowid)
    const placeholders = rowids.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT rowid, id, title, kind, created_at FROM artifacts WHERE rowid IN (${placeholders})`
    ).all(...rowids) as { rowid: number; id: string; title: string; kind: string; created_at: number }[]

    const distMap = new Map(annRows.map(r => [r.artifact_rowid, r.distance]))
    return rows
      .map(a => ({ id: a.id, title: a.title, kind: a.kind, created_at: a.created_at, score: 1 / (1 + (distMap.get(a.rowid) ?? Infinity)) }))
      .sort((x, y) => y.score - x.score)
  } catch (err) {
    logger.debug({ err }, 'searchArtifactsByVector: ANN query failed')
    return []
  }
}

// --- Pending Channel Requests ---

export interface PendingChannelRequest {
  id: number
  agent: string
  channel_id: string
  channel_name: string | null
  user_id: string | null
  requested_at: number
  status: 'pending' | 'approved' | 'denied'
}

export function upsertChannelRequest(agent: string, channelId: string, userId?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 86400
  const existing = db.prepare(
    "SELECT id FROM pending_channel_requests WHERE agent = ? AND channel_id = ? AND (status = 'pending' OR (status = 'denied' AND COALESCE(resolved_at, requested_at) > ?))"
  ).get(agent, channelId, sevenDaysAgo)
  if (existing) return false
  db.prepare(
    'INSERT INTO pending_channel_requests (agent, channel_id, user_id, requested_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, channelId, userId ?? null, now, 'pending')
  return true
}

export function listPendingChannelRequests(agent: string): PendingChannelRequest[] {
  return db.prepare(
    "SELECT * FROM pending_channel_requests WHERE agent = ? AND status = 'pending' ORDER BY requested_at DESC"
  ).all(agent) as PendingChannelRequest[]
}

export function updateChannelRequestStatus(id: number, status: 'approved' | 'denied'): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(
    'UPDATE pending_channel_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = ?'
  ).run(status, now, id, 'pending').changes > 0
}

export function updateChannelRequestName(id: number, channelName: string): void {
  db.prepare('UPDATE pending_channel_requests SET channel_name = ? WHERE id = ?').run(channelName, id)
}

// --- Telegram History ---

export function saveTelegramMessage(
  chatId: string,
  messageId: string,
  direction: 'in' | 'out',
  text: string,
  userId?: string,
  ts?: number,
): void {
  const now = ts ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO telegram_history (chat_id, message_id, user_id, direction, text, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(chatId, messageId, userId ?? null, direction, text, now)
}

export interface TelegramHistoryRow {
  id: number
  chat_id: string
  message_id: string
  user_id: string | null
  direction: 'in' | 'out'
  text: string
  ts: number
}

export function getTelegramHistory(chatId: string, limit: number = 50): TelegramHistoryRow[] {
  return db.prepare(
    'SELECT * FROM telegram_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?'
  ).all(chatId, limit) as TelegramHistoryRow[]
}

// --- Idea Box ---

export interface IdeaBoxRow {
  id: string
  title: string
  description: string | null
  category: string
  status: 'new' | 'reviewed' | 'kanban' | 'rejected'
  source: string
  kanban_id: string | null
  impact: number | null
  effort: number | null
  created_at: number
  updated_at: number
}

export function listIdeas(opts?: { status?: string; category?: string }): IdeaBoxRow[] {
  let q = 'SELECT * FROM idea_box WHERE 1=1'
  const params: string[] = []
  if (opts?.status) { q += ' AND status = ?'; params.push(opts.status) }
  if (opts?.category) { q += ' AND category = ?'; params.push(opts.category) }
  q += ' ORDER BY created_at DESC'
  return db.prepare(q).all(...params) as IdeaBoxRow[]
}

export function createIdea(idea: Omit<IdeaBoxRow, 'created_at' | 'updated_at'>): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO idea_box (id, title, description, category, status, source, kanban_id, impact, effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(idea.id, idea.title, idea.description ?? null, idea.category, idea.status, idea.source, idea.kanban_id ?? null, idea.impact ?? null, idea.effort ?? null, now, now)
}

export function updateIdea(id: string, patch: Partial<Pick<IdeaBoxRow, 'title' | 'description' | 'category' | 'status' | 'kanban_id' | 'impact' | 'effort'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category) }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.kanban_id !== undefined) { sets.push('kanban_id = ?'); params.push(patch.kanban_id) }
  if (patch.impact !== undefined) { sets.push('impact = ?'); params.push(patch.impact) }
  if (patch.effort !== undefined) { sets.push('effort = ?'); params.push(patch.effort) }
  params.push(id)
  return db.prepare(`UPDATE idea_box SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteIdea(id: string): boolean {
  return db.prepare('DELETE FROM idea_box WHERE id = ?').run(id).changes > 0
}

export function listIdeaCategories(): string[] {
  return (db.prepare('SELECT DISTINCT category FROM idea_box ORDER BY category').all() as { category: string }[]).map(r => r.category)
}

// --- Idea Comments ---

export interface IdeaComment {
  id: number
  idea_id: string
  author: string
  content: string
  created_at: number
}

export function getIdeaComments(ideaId: string): IdeaComment[] {
  return db.prepare('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC').all(ideaId) as IdeaComment[]
}

export function addIdeaComment(ideaId: string, author: string, content: string): IdeaComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(ideaId, author, content, now)
  db.prepare('UPDATE idea_box SET updated_at = ? WHERE id = ?').run(now, ideaId)
  return { id: Number(info.lastInsertRowid), idea_id: ideaId, author, content, created_at: now }
}

// --- Idea Status Log ---

export interface IdeaStatusLogRow {
  id: number
  idea_id: string
  from_status: string | null
  to_status: string
  actor: string
  note: string | null
  created_at: number
}

export function logIdeaStatusChange(
  ideaId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  note?: string,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ideaId, fromStatus ?? null, toStatus, actor, note ?? null, now)
}

export function getIdeaStatusLog(ideaId: string): IdeaStatusLogRow[] {
  return db.prepare('SELECT * FROM idea_status_log WHERE idea_id = ? ORDER BY created_at ASC').all(ideaId) as IdeaStatusLogRow[]
}

// Revert a promoted idea back to 'reviewed' when its kanban card is deleted or archived.
// Returns the idea id if a matching idea was found and reverted, null otherwise.
export function revertIdeaFromKanban(kanbanId: string): string | null {
  const idea = db.prepare("SELECT id, status FROM idea_box WHERE kanban_id = ? AND status = 'kanban'").get(kanbanId) as { id: string; status: string } | undefined
  if (!idea) return null
  const now = Math.floor(Date.now() / 1000)
  db.prepare("UPDATE idea_box SET status = 'reviewed', kanban_id = NULL, updated_at = ? WHERE id = ?").run(now, idea.id)
  logIdeaStatusChange(idea.id, 'kanban', 'reviewed', 'system', `Kanban card removed: ${kanbanId}`)
  return idea.id
}

// --- Tool Call Log ---

export function logToolCall(
  sessionId: string,
  toolName: string,
  inputSummary: string | null,
  success = true,
  agentId: string | null = null,
  traceId: string | null = null,
  durationMs: number | null = null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at, agent_id, trace_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(sessionId, toolName, inputSummary, success ? 1 : 0, now, agentId, traceId, durationMs)
}

export interface ToolCallLogRow {
  id: number
  session_id: string
  tool_name: string
  input_summary: string | null
  success: number
  created_at: number
  agent_id: string | null
  trace_id: string | null
  duration_ms: number | null
}

export interface WorkflowCandidate {
  session_id: string
  tool_calls: ToolCallLogRow[]
  start_ts: number
  end_ts: number
  duration_minutes: number
}

export function getRecentToolCalls(sinceSecs: number): ToolCallLogRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - sinceSecs
  return db.prepare('SELECT * FROM tool_call_log WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff) as ToolCallLogRow[]
}

export function analyzeWorkflowCandidates(sinceSecs = 3600, minToolCalls = 5, gapSecs = 300): WorkflowCandidate[] {
  const calls = getRecentToolCalls(sinceSecs)
  if (calls.length === 0) return []

  // Group by session_id, then split by time gaps > gapSecs
  const bySession: Map<string, ToolCallLogRow[]> = new Map()
  for (const c of calls) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, [])
    bySession.get(c.session_id)!.push(c)
  }

  const candidates: WorkflowCandidate[] = []
  for (const [sessionId, sessionCalls] of bySession) {
    // Split into chunks by time gap
    const chunks: ToolCallLogRow[][] = []
    let current: ToolCallLogRow[] = [sessionCalls[0]]
    for (let i = 1; i < sessionCalls.length; i++) {
      if (sessionCalls[i].created_at - sessionCalls[i - 1].created_at > gapSecs) {
        chunks.push(current)
        current = []
      }
      current.push(sessionCalls[i])
    }
    chunks.push(current)

    for (const chunk of chunks) {
      if (chunk.length >= minToolCalls) {
        candidates.push({
          session_id: sessionId,
          tool_calls: chunk,
          start_ts: chunk[0].created_at,
          end_ts: chunk[chunk.length - 1].created_at,
          duration_minutes: Math.round((chunk[chunk.length - 1].created_at - chunk[0].created_at) / 60),
        })
      }
    }
  }

  return candidates
}

export function pruneToolCallLog(olderThanSecs = 86400): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs
  db.prepare('DELETE FROM tool_call_log WHERE created_at < ?').run(cutoff)
}

// --- Skill Usage Log ---

export interface SkillUsageRow {
  id: number
  agent_id: string
  skill_name: string
  trigger_type: 'tool_call' | 'skill_read'
  session_id: string | null
  created_at: number
}

export interface SkillUsageStatRow {
  skill_name: string
  call_count: number
  read_count: number
  total_count: number
  agent_count: number
  last_used_at: number
}

export function logSkillUsage(
  agentId: string,
  skillName: string,
  triggerType: 'tool_call' | 'skill_read',
  sessionId?: string | null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(agentId, skillName, triggerType, sessionId ?? null, now)
}

export function getSkillUsageRows(opts: {
  since?: number
  agentId?: string
  skillName?: string
  limit?: number
}): SkillUsageRow[] {
  const { since, agentId, skillName, limit = 500 } = opts
  const cutoff = since ? Math.floor(Date.now() / 1000) - since : 0
  const conditions: string[] = ['created_at >= ?']
  const params: unknown[] = [cutoff]
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId) }
  if (skillName) { conditions.push('skill_name = ?'); params.push(skillName) }
  params.push(limit)
  return db.prepare(
    `SELECT * FROM skill_usage WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params) as SkillUsageRow[]
}

export function getSkillUsageStats(sinceSecs?: number): SkillUsageStatRow[] {
  const cutoff = sinceSecs ? Math.floor(Date.now() / 1000) - sinceSecs : 0
  return db.prepare(`
    SELECT
      skill_name,
      SUM(CASE WHEN trigger_type = 'tool_call' THEN 1 ELSE 0 END) AS call_count,
      SUM(CASE WHEN trigger_type = 'skill_read' THEN 1 ELSE 0 END) AS read_count,
      COUNT(*) AS total_count,
      COUNT(DISTINCT agent_id) AS agent_count,
      MAX(created_at) AS last_used_at
    FROM skill_usage
    WHERE created_at >= ?
    GROUP BY skill_name
    ORDER BY total_count DESC
  `).all(cutoff) as SkillUsageStatRow[]
}

export interface SkillUsageSummaryRow {
  skill_name: string
  last_used_at: number
  total_count: number
  count_30d: number
  count_90d: number
}

export function getSkillUsageSummary(): SkillUsageSummaryRow[] {
  const now = Math.floor(Date.now() / 1000)
  const cutoff30 = now - 30 * 86400
  const cutoff90 = now - 90 * 86400
  return db.prepare(`
    SELECT
      skill_name,
      MAX(created_at) AS last_used_at,
      COUNT(*) AS total_count,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS count_30d,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS count_90d
    FROM skill_usage
    GROUP BY skill_name
    ORDER BY last_used_at DESC
  `).all(cutoff30, cutoff90) as SkillUsageSummaryRow[]
}

// --- Config Change Log ---
// Pass null for oldValue/newValue when the registry entry is secret:true --
// this keeps secret values out of the audit trail entirely rather than
// relying on a UI to not display them.
export function logConfigChange(
  key: string,
  oldValue: string | number | null,
  newValue: string | number | null,
  actor: string,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(key, oldValue === null ? null : String(oldValue), newValue === null ? null : String(newValue), actor, now)
}

export interface ConfigChangeLogRow {
  id: number
  key: string
  old_value: string | null
  new_value: string | null
  actor: string
  created_at: number
}

export function getRecentConfigChanges(limit = 200): ConfigChangeLogRow[] {
  // id DESC as a tiebreaker: created_at has 1-second resolution, so two
  // saves in the same second would otherwise sort arbitrarily.
  return db.prepare('SELECT * FROM config_change_log ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as ConfigChangeLogRow[]
}

// --- Store File Audit ---

export interface StoreFileAuditRow {
  id: number
  rel_path: string
  event_type: string
  is_sensitive: number
  file_size: number | null
  agent: string | null
  created_at: number
}

export function logStoreFileEvent(
  relPath: string,
  eventType: string,
  isSensitive: number,
  fileSize: number | null,
  agent: string | null = null,
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO store_file_audit (rel_path, event_type, is_sensitive, file_size, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(relPath, eventType, isSensitive, fileSize, agent, now)
}

export function getRecentStoreFileEvents(limit = 200): StoreFileAuditRow[] {
  return db.prepare('SELECT * FROM store_file_audit ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as StoreFileAuditRow[]
}

// --- Unified Audit Log Query ---

export type AuditSource = 'config' | 'idea' | 'store' | 'diary' | 'agent'

export interface AuditLogEntry {
  id: number
  source: AuditSource
  created_at: number
  actor?: string
  // config
  key?: string
  old_value?: string | null
  new_value?: string | null
  // idea
  idea_id?: string
  from_status?: string | null
  to_status?: string
  note?: string | null
  // store
  rel_path?: string
  event_type?: string
  is_sensitive?: number
  file_size?: number | null
  // diary (daily_logs + memories)
  agent_id?: string
  content?: string
  category?: string
  keywords?: string
  entry_type?: 'log' | 'memory'
  // agent
  entity?: string
  action?: string
  entity_id?: string
  detail?: string
}

export interface AgentAuditLogRow {
  id: number
  agent_id: string
  entity: string
  action: string
  entity_id: string | null
  detail: string | null
  created_at: number
}

export function writeAgentAuditLog(opts: {
  agent_id: string
  entity: 'memory' | 'kanban' | 'message' | 'agent'
  action: 'create' | 'update' | 'delete'
  entity_id?: string | number | null
  detail?: Record<string, unknown> | null
}): void {
  db.prepare(
    'INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
  ).run(
    opts.agent_id,
    opts.entity,
    opts.action,
    opts.entity_id != null ? String(opts.entity_id) : null,
    opts.detail != null ? JSON.stringify(opts.detail) : null
  )
}

export function queryAuditLog(opts: {
  sources: AuditSource[]
  from?: number
  to?: number
  q?: string
  agent?: string
  limit: number
}): AuditLogEntry[] {
  const { sources, from, to, q, agent, limit } = opts
  const all: AuditSource[] = ['config', 'idea', 'store', 'diary', 'agent']
  const active = sources.length > 0 ? sources : all

  const parts: AuditLogEntry[] = []

  if (active.includes('config')) {
    let sql = 'SELECT id, key, old_value, new_value, actor, created_at FROM config_change_log WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (q)    { sql += ' AND (key LIKE ? OR old_value LIKE ? OR new_value LIKE ? OR actor LIKE ?)'; const p = `%${q}%`; params.push(p, p, p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as ConfigChangeLogRow[]
    for (const r of rows) parts.push({ ...r, source: 'config' })
  }

  if (active.includes('idea')) {
    let sql = 'SELECT id, idea_id, from_status, to_status, actor, note, created_at FROM idea_status_log WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (q)    { sql += ' AND (idea_id LIKE ? OR to_status LIKE ? OR note LIKE ? OR actor LIKE ?)'; const p = `%${q}%`; params.push(p, p, p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as Array<{ id: number; idea_id: string; from_status: string | null; to_status: string; actor: string; note: string | null; created_at: number }>
    for (const r of rows) parts.push({ ...r, source: 'idea' })
  }

  if (active.includes('store')) {
    let sql = 'SELECT id, rel_path, event_type, is_sensitive, file_size, agent, created_at FROM store_file_audit WHERE 1=1'
    const params: unknown[] = []
    if (from) { sql += ' AND created_at >= ?'; params.push(from) }
    if (to)   { sql += ' AND created_at <= ?'; params.push(to) }
    if (agent) { sql += ' AND agent = ?'; params.push(agent) }
    if (q)    { sql += ' AND (rel_path LIKE ? OR agent LIKE ?)'; const p = `%${q}%`; params.push(p, p) }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; params.push(limit)
    const rows = db.prepare(sql).all(...params) as StoreFileAuditRow[]
    for (const r of rows) parts.push({ ...r, source: 'store' })
  }

  if (active.includes('diary')) {
    // daily_logs
    let logSql = 'SELECT id, agent_id, content, created_at FROM daily_logs WHERE 1=1'
    const logParams: unknown[] = []
    if (from)  { logSql += ' AND created_at >= ?'; logParams.push(from) }
    if (to)    { logSql += ' AND created_at <= ?'; logParams.push(to) }
    if (agent) { logSql += ' AND agent_id = ?'; logParams.push(agent) }
    if (q)     { logSql += ' AND content LIKE ?'; logParams.push(`%${q}%`) }
    logSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; logParams.push(limit)
    const logRows = db.prepare(logSql).all(...logParams) as Array<{ id: number; agent_id: string; content: string; created_at: number }>
    for (const r of logRows) parts.push({ id: r.id, source: 'diary', created_at: r.created_at, agent_id: r.agent_id, content: r.content, entry_type: 'log' })

    // memories
    let memSql = 'SELECT id, agent_id, content, category, keywords, created_at FROM memories WHERE 1=1'
    const memParams: unknown[] = []
    if (from)  { memSql += ' AND created_at >= ?'; memParams.push(from) }
    if (to)    { memSql += ' AND created_at <= ?'; memParams.push(to) }
    if (agent) { memSql += ' AND agent_id = ?'; memParams.push(agent) }
    if (q)     { memSql += ' AND (content LIKE ? OR keywords LIKE ?)'; memParams.push(`%${q}%`, `%${q}%`) }
    memSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; memParams.push(limit)
    const memRows = db.prepare(memSql).all(...memParams) as Array<{ id: number; agent_id: string; content: string; category: string; keywords: string | null; created_at: number }>
    for (const r of memRows) parts.push({ id: r.id, source: 'diary', created_at: r.created_at, agent_id: r.agent_id, content: r.content, category: r.category, keywords: r.keywords ?? undefined, entry_type: 'memory' })
  }

  if (active.includes('agent')) {
    let agentSql = 'SELECT id, agent_id, entity, action, entity_id, detail, created_at FROM agent_audit_log WHERE 1=1'
    const agentParams: unknown[] = []
    if (from)  { agentSql += ' AND created_at >= ?'; agentParams.push(from) }
    if (to)    { agentSql += ' AND created_at <= ?'; agentParams.push(to) }
    if (agent) { agentSql += ' AND agent_id = ?'; agentParams.push(agent) }
    if (q)     { agentSql += ' AND (agent_id LIKE ? OR entity LIKE ? OR action LIKE ? OR detail LIKE ?)'; const p = `%${q}%`; agentParams.push(p, p, p, p) }
    agentSql += ' ORDER BY created_at DESC, id DESC LIMIT ?'; agentParams.push(limit)
    const agentRows = db.prepare(agentSql).all(...agentParams) as AgentAuditLogRow[]
    for (const r of agentRows) parts.push({
      id: r.id, source: 'agent', created_at: r.created_at,
      agent_id: r.agent_id, entity: r.entity, action: r.action,
      entity_id: r.entity_id ?? undefined, detail: r.detail ?? undefined,
    })
  }

  // Merge and sort by created_at DESC, then id DESC as tiebreaker
  parts.sort((a, b) => b.created_at - a.created_at || (b.id ?? 0) - (a.id ?? 0))
  return parts.slice(0, limit)
}

// Prune all three audit tables to AUDIT_LOG_RETENTION_DAYS. Called from the
// daily decay sweep so old entries do not accumulate indefinitely.
export function pruneAuditLogs(): void {
  const retentionDays = Number(getEffectiveSettingValue('AUDIT_LOG_RETENTION_DAYS'))
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
  db.prepare('DELETE FROM config_change_log WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM idea_status_log WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM store_file_audit WHERE created_at < ?').run(cutoff)
  db.prepare('DELETE FROM agent_audit_log WHERE created_at < ?').run(cutoff)
}

export interface TokenUsagePruneResult {
  rawDeleted: number
  dailyUpserted: number
  monthlyUpserted: number
}

// Prune token_usage rows older than TOKEN_USAGE_RETENTION_DAYS. The table is the
// main DB-growth driver (one row per inbound token-log event); without aggregation
// it grows unbounded. Called from the daily decay sweep.
//
// Strategy: aggregate rows older than the raw window into token_usage_daily and
// token_usage_monthly (idempotent upserts) BEFORE deleting the raw rows, so
// billing/cost-audit history is never lost. The aggregator tables are then pruned
// to their own retention windows (daily: 1 year, monthly: 3 years).
//
// `timestamp` is unix SECONDS.
export function pruneTokenUsage(): TokenUsagePruneResult {
  const rawRetentionDays    = Number(getEffectiveSettingValue('TOKEN_USAGE_RETENTION_DAYS'))
  const dailyRetentionDays  = Number(getEffectiveSettingValue('TOKEN_USAGE_DAILY_RETENTION_DAYS'))
  const monthlyRetentionDays = Number(getEffectiveSettingValue('TOKEN_USAGE_MONTHLY_RETENTION_DAYS'))

  const rawCutoff = Math.floor(Date.now() / 1000) - rawRetentionDays * 86400

  // 1. Daily rollup upsert (idempotent: ON CONFLICT overwrites with fresh aggregate).
  //    Runs only over rows that fall outside the raw retention window.
  const dailyResult = db.prepare(`
    INSERT INTO token_usage_daily
      (day, agent, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, thinking_tokens, row_count)
    SELECT
      date(timestamp, 'unixepoch', 'localtime') AS day,
      agent,
      COALESCE(model, '') AS model,
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(cache_read_tokens),
      SUM(cache_creation_tokens),
      SUM(thinking_tokens),
      COUNT(*)
    FROM token_usage
    WHERE timestamp < ?
    GROUP BY date(timestamp, 'unixepoch', 'localtime'), agent, COALESCE(model, '')
    ON CONFLICT(day, agent, model) DO UPDATE SET
      input_tokens          = excluded.input_tokens,
      output_tokens         = excluded.output_tokens,
      cache_read_tokens     = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      thinking_tokens       = excluded.thinking_tokens,
      row_count             = excluded.row_count
  `).run(rawCutoff)

  // 2. Monthly rollup upsert (idempotent).
  const monthlyResult = db.prepare(`
    INSERT INTO token_usage_monthly
      (month, agent, model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, thinking_tokens, session_count, row_count)
    SELECT
      strftime('%Y-%m', timestamp, 'unixepoch', 'localtime') AS month,
      agent,
      COALESCE(model, '') AS model,
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(cache_read_tokens),
      SUM(cache_creation_tokens),
      SUM(thinking_tokens),
      COUNT(DISTINCT session_id),
      COUNT(*)
    FROM token_usage
    WHERE timestamp < ?
    GROUP BY strftime('%Y-%m', timestamp, 'unixepoch', 'localtime'), agent, COALESCE(model, '')
    ON CONFLICT(month, agent, model) DO UPDATE SET
      input_tokens          = excluded.input_tokens,
      output_tokens         = excluded.output_tokens,
      cache_read_tokens     = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      thinking_tokens       = excluded.thinking_tokens,
      session_count         = excluded.session_count,
      row_count             = excluded.row_count
  `).run(rawCutoff)

  // 3. Delete raw rows only after both rollups are committed.
  const deleteResult = db.prepare('DELETE FROM token_usage WHERE timestamp < ?').run(rawCutoff)

  // 4. Prune the aggregator tables to their own retention windows.
  db.prepare(
    "DELETE FROM token_usage_daily WHERE day < date(?, 'unixepoch', 'localtime')"
  ).run(Math.floor(Date.now() / 1000) - dailyRetentionDays * 86400)

  db.prepare(
    "DELETE FROM token_usage_monthly WHERE month < strftime('%Y-%m', ?, 'unixepoch', 'localtime')"
  ).run(Math.floor(Date.now() / 1000) - monthlyRetentionDays * 86400)

  return {
    rawDeleted:      deleteResult.changes,
    dailyUpserted:   dailyResult.changes,
    monthlyUpserted: monthlyResult.changes,
  }
}

// --- Vault SSH Keys (shared key pool) ---
// Each key is independent of any server -- one key may be assigned to many
// servers. The private key blob lives in the AES-256-GCM vault (vault.ts);
// only its id (vault_key_id) is stored here. public_key and fingerprint are
// safe to surface in the API; the private key never leaves the backend.

export interface VaultSshKey {
  id: string
  label: string
  username: string
  vault_key_id: string
  public_key: string
  fingerprint: string
  key_type: string
  created_at: number
}

export function listVaultSshKeys(): VaultSshKey[] {
  return db.prepare('SELECT * FROM vault_ssh_keys ORDER BY label ASC').all() as VaultSshKey[]
}

export function getVaultSshKey(id: string): VaultSshKey | undefined {
  return db.prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get(id) as VaultSshKey | undefined
}

export function createVaultSshKey(key: Pick<VaultSshKey, 'id' | 'label' | 'username' | 'vault_key_id' | 'public_key' | 'fingerprint' | 'key_type'>): VaultSshKey {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO vault_ssh_keys (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(key.id, key.label, key.username, key.vault_key_id, key.public_key, key.fingerprint, key.key_type, now)
  return { ...key, created_at: now }
}

// Unassign the key from all servers, then delete it. Returns the count of
// servers that were unassigned so callers can surface that in the response.
export function deleteVaultSshKey(id: string): { deleted: boolean; unassigned: number } {
  return db.transaction(() => {
    const unassigned = db.prepare(
      'UPDATE vault_ssh_servers SET ssh_key_id = NULL, updated_at = ? WHERE ssh_key_id = ?'
    ).run(Math.floor(Date.now() / 1000), id).changes
    const deleted = db.prepare('DELETE FROM vault_ssh_keys WHERE id = ?').run(id).changes > 0
    return { deleted, unassigned }
  })()
}

// --- Vault SSH Servers ---
// Stores server metadata. The ssh_key_id FK points to vault_ssh_keys (nullable;
// null = no key assigned = keyStatus "missing"). Legacy per-server key columns
// (vault_key_id, key_type, fingerprint, key_expires_at) have been removed via
// DROP COLUMN migration above.

export interface VaultSshServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  ssh_key_id: string | null
  description: string | null
  created_at: number
  updated_at: number
}

export type SshKeyStatus = 'ok' | 'missing'

export function computeSshKeyStatus(server: VaultSshServer): SshKeyStatus {
  return server.ssh_key_id ? 'ok' : 'missing'
}

export function listVaultSshServers(): VaultSshServer[] {
  return db.prepare('SELECT * FROM vault_ssh_servers ORDER BY name ASC').all() as VaultSshServer[]
}

export function getVaultSshServer(id: string): VaultSshServer | undefined {
  return db.prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get(id) as VaultSshServer | undefined
}

export function createVaultSshServer(server: Pick<VaultSshServer, 'id' | 'name' | 'host' | 'port' | 'username' | 'description'>): VaultSshServer {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO vault_ssh_servers (id, name, host, port, username, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(server.id, server.name, server.host, server.port, server.username, server.description ?? null, now, now)
  return { ...server, ssh_key_id: null, created_at: now, updated_at: now }
}

export function updateVaultSshServer(id: string, patch: Partial<Pick<VaultSshServer, 'name' | 'host' | 'port' | 'username' | 'ssh_key_id' | 'description'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        params.push(patch.name) }
  if (patch.host !== undefined)        { sets.push('host = ?');        params.push(patch.host) }
  if (patch.port !== undefined)        { sets.push('port = ?');        params.push(patch.port) }
  if (patch.username !== undefined)    { sets.push('username = ?');    params.push(patch.username) }
  if (patch.ssh_key_id !== undefined)  { sets.push('ssh_key_id = ?'); params.push(patch.ssh_key_id) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  params.push(id)
  return db.prepare(`UPDATE vault_ssh_servers SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteVaultSshServer(id: string): boolean {
  return db.prepare('DELETE FROM vault_ssh_servers WHERE id = ?').run(id).changes > 0
}

// --- Approvals (HITL) ---

export interface Approval {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload: string | null
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  timeout_at: number | null
  telegram_message_id: number | null
  requested_at: number
  resolved_at: number | null
  resolved_by: string | null
  tenant_id: string | null
}

export function createApproval(params: {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload?: string | null
  timeout_at?: number | null
  tenant_id?: string | null
}): Approval {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO approvals (id, agent_id, category, action_description, action_payload, timeout_at, requested_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.agent_id,
    params.category,
    params.action_description,
    params.action_payload ?? null,
    params.timeout_at ?? null,
    now,
    params.tenant_id ?? null,
  )
  return {
    id: params.id,
    agent_id: params.agent_id,
    category: params.category,
    action_description: params.action_description,
    action_payload: params.action_payload ?? null,
    status: 'pending',
    timeout_at: params.timeout_at ?? null,
    telegram_message_id: null,
    requested_at: now,
    resolved_at: null,
    resolved_by: null,
    tenant_id: params.tenant_id ?? null,
  }
}

export function getApproval(id: string): Approval | undefined {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined
}

export function resolveApproval(id: string, status: 'approved' | 'rejected' | 'timeout', resolvedBy: string, telegramMessageId?: number | null): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    UPDATE approvals
    SET status = ?, resolved_at = ?, resolved_by = ?,
        telegram_message_id = COALESCE(?, telegram_message_id)
    WHERE id = ? AND status = 'pending'
  `).run(status, now, resolvedBy, telegramMessageId ?? null, id).changes > 0
}

export function listApprovals(opts: {
  agent_id?: string
  category?: string
  status?: string
  limit?: number
  tenantId?: string
}): Approval[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.agent_id) { conditions.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category) }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status) }
  // SQL-level tenant filter must come before LIMIT (per 626/704 pagination lesson).
  if (opts.tenantId !== undefined) { conditions.push('tenant_id = ?'); params.push(opts.tenantId) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(opts.limit ?? 100, 500)
  params.push(limit)
  return db.prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT ?`).all(...params) as Approval[]
}

// Stamp trace context onto an agent_messages row that was created without one.
// Called by the message-router tick BEFORE delivery so the span is stamped
// exactly once (pending rows only -- delivered/done rows are already closed).
export function stampMessageTrace(
  id: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
): boolean {
  return db.prepare(`
    UPDATE agent_messages
       SET trace_id = ?, span_id = ?, parent_span_id = ?
     WHERE id = ? AND status = 'pending' AND trace_id IS NULL
  `).run(traceId, spanId, parentSpanId, id).changes > 0
}

export function expireTimedOutApprovals(): number {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    UPDATE approvals SET status = 'timeout', resolved_at = ?
    WHERE status = 'pending' AND timeout_at IS NOT NULL AND timeout_at <= ?
  `).run(now, now).changes
}

// --- OTel Distributed Tracing (card def5a189) ---

export interface OtelSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  agent_id: string
  operation: string
  start_ms: number
  end_ms: number | null
  status: 'ok' | 'error' | 'timeout' | 'running'
  attributes: string | null
}

export function upsertOtelSpan(span: Omit<OtelSpan, 'end_ms' | 'status'> & { end_ms?: number | null; status?: OtelSpan['status'] }): void {
  db.prepare(`
    INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      end_ms = excluded.end_ms,
      status = excluded.status,
      attributes = COALESCE(excluded.attributes, otel_spans.attributes)
  `).run(
    span.trace_id, span.span_id, span.parent_span_id ?? null,
    span.agent_id, span.operation, span.start_ms,
    span.end_ms ?? null, span.status ?? 'running', span.attributes ?? null,
  )
}

export function closeOtelSpan(traceId: string, spanId: string, endMs: number, status: OtelSpan['status']): boolean {
  return db.prepare(`
    UPDATE otel_spans SET end_ms = ?, status = ? WHERE trace_id = ? AND span_id = ?
  `).run(endMs, status, traceId, spanId).changes > 0
}

export function getOtelTrace(traceId: string): OtelSpan[] {
  return db.prepare('SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_ms ASC')
    .all(traceId) as OtelSpan[]
}

export interface OtelTraceSummary {
  trace_id: string
  root_operation: string
  root_agent: string
  start_ms: number
  end_ms: number | null
  span_count: number
  status: string
}

// Query spans for OTEL JSON export. All params are optional.
export function queryOtelSpans(opts: {
  agent?: string
  fromMs?: number
  toMs?: number
  limit?: number
}): OtelSpan[] {
  const { agent, fromMs, toMs, limit = 1000 } = opts
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (agent) { clauses.push('agent_id = ?'); params.push(agent) }
  if (fromMs !== undefined) { clauses.push('start_ms >= ?'); params.push(fromMs) }
  if (toMs !== undefined) { clauses.push('start_ms <= ?'); params.push(toMs) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(Math.min(limit, 5000))
  return db.prepare(
    `SELECT * FROM otel_spans ${where} ORDER BY start_ms ASC LIMIT ?`,
  ).all(...params) as OtelSpan[]
}

export function listOtelTraces(limit = 50): OtelTraceSummary[] {
  return db.prepare(`
    SELECT
      s.trace_id,
      s.operation  AS root_operation,
      s.agent_id   AS root_agent,
      s.start_ms,
      (SELECT MAX(end_ms) FROM otel_spans WHERE trace_id = s.trace_id) AS end_ms,
      (SELECT COUNT(*)    FROM otel_spans WHERE trace_id = s.trace_id) AS span_count,
      CASE
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'error')   THEN 'error'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'timeout') THEN 'timeout'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'running') THEN 'running'
        ELSE 'ok'
      END AS status
    FROM otel_spans s
    WHERE s.parent_span_id IS NULL
    ORDER BY s.start_ms DESC
    LIMIT ?
  `).all(limit) as OtelTraceSummary[]
}

// ── B2B Tenant registry ───────────────────────────────────────────────────────

export interface Tenant {
  id: string
  display_name: string
  created_at: number
  disabled_at: number | null
}

export function createTenant(id: string, displayName: string): Tenant {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)')
    .run(id, displayName, now)
  return { id, display_name: displayName, created_at: now, disabled_at: null }
}

export function getTenant(id: string): Tenant | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant | undefined
}

export function listTenants(includeDisabled = false): Tenant[] {
  if (includeDisabled) {
    return db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as Tenant[]
  }
  return db.prepare('SELECT * FROM tenants WHERE disabled_at IS NULL ORDER BY created_at ASC').all() as Tenant[]
}

export function updateTenant(id: string, patch: { display_name?: string; disabled?: boolean }): Tenant | null {
  const existing = getTenant(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.display_name !== undefined) {
    fields.push('display_name = ?')
    params.push(patch.display_name)
  }
  if (patch.disabled === true) {
    fields.push('disabled_at = ?')
    params.push(now)
  } else if (patch.disabled === false) {
    fields.push('disabled_at = NULL')
  }
  if (fields.length === 0) return existing
  params.push(id)
  db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant
}

// Permanently delete a tenant and all its associated data.
// Deletion order respects FK constraints and audit requirements:
//   1. Reject pending approvals first (before dashboard_users are gone).
//   2. Revoke api_tokens (tombstone: kept for access-history audit, revoked_at set).
//   3. Drop identity/access rows: dashboard_users, partner_senders, device_keys.
//   4. Drop all approvals (including now-rejected ones per Jonas 2026-08-30).
//   5. Drop agent_messages and import_memories.
//   6. Drop kanban child tables before kanban_cards.
//   7. Drop memories row-by-row with vec0 sync (safe path chosen 2026-08-30).
//   8. Drop artifacts (vec_artifacts cleaned by DELETE trigger).
//   9. Drop schedules (tenant_id IS NULL = fleet scope, untouched).
//  10. Drop skill_tenant_access before skills (FK; SQLite FK enforcement is off by default).
//  11. Drop skills.
//  12. Drop vec_workspace_docs then workspace_docs (app-level vec sync, no trigger).
//  13. Drop tenant_agent_availability.
//  14. Drop the tenant row itself.
// The 'default' tenant is permanently guarded and throws if passed.
export function deleteTenant(tenantId: string): { memoriesDeleted: number } {
  if (tenantId === 'default') throw new Error('Cannot delete the default tenant')

  return db.transaction((): { memoriesDeleted: number } => {
    // 1. Reject pending approvals
    db.prepare(
      "UPDATE approvals SET status = 'rejected', resolved_at = unixepoch() WHERE tenant_id = ? AND status = 'pending'",
    ).run(tenantId)

    // 2. Revoke api_tokens (tombstone -- keep row for audit, mark revoked)
    db.prepare('UPDATE api_tokens SET revoked_at = unixepoch() WHERE tenant_id = ? AND revoked_at IS NULL').run(tenantId)

    // 3. Drop identity/access rows
    db.prepare('DELETE FROM dashboard_users WHERE tenant_id = ?').run(tenantId)
    db.prepare('DELETE FROM partner_senders WHERE tenant_id = ?').run(tenantId)
    db.prepare('DELETE FROM device_keys WHERE tenant_id = ?').run(tenantId)

    // 4. Drop all approvals
    db.prepare('DELETE FROM approvals WHERE tenant_id = ?').run(tenantId)

    // 5. Drop messages and import memories
    db.prepare('DELETE FROM agent_messages WHERE tenant_id = ?').run(tenantId)
    db.prepare('DELETE FROM import_memories WHERE tenant_id = ?').run(tenantId)

    // 6. Drop kanban (child tables before parent)
    const cardIds = (
      db.prepare('SELECT id FROM kanban_cards WHERE tenant_id = ?').all(tenantId) as { id: string }[]
    ).map((r) => r.id)
    if (cardIds.length > 0) {
      const ph = cardIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM kanban_card_labels WHERE card_id IN (${ph})`).run(...cardIds)
      db.prepare(`DELETE FROM kanban_card_events  WHERE card_id IN (${ph})`).run(...cardIds)
      db.prepare(`DELETE FROM kanban_comments     WHERE card_id IN (${ph})`).run(...cardIds)
    }
    db.prepare('DELETE FROM kanban_cards WHERE tenant_id = ?').run(tenantId)

    // 7. Drop memories -- row-by-row to keep vec0 index in sync (same connection, safe inside tx)
    const memIds = (
      db.prepare('SELECT id FROM memories WHERE tenant_id = ?').all(tenantId) as { id: number }[]
    ).map((r) => r.id)
    for (const id of memIds) {
      syncVecMemoryDelete(id)
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    }

    // 8. Drop artifacts (vec_artifacts kept in sync by the vec_artifacts_ad DELETE trigger)
    db.prepare('DELETE FROM artifacts WHERE tenant_id = ?').run(tenantId)

    // 9. Drop schedules (tenant_id IS NULL = fleet scope, those are untouched)
    db.prepare('DELETE FROM schedules WHERE tenant_id = ?').run(tenantId)

    // 10 & 11. Drop skill_tenant_access before skills (SQLite FK enforcement is off by default;
    //          explicit two-pass: access grants TO this tenant, then grants FROM its skills).
    db.prepare('DELETE FROM skill_tenant_access WHERE tenant_id = ?').run(tenantId)
    const skillIds = (
      db.prepare('SELECT id FROM skills WHERE tenant_id = ?').all(tenantId) as { id: string }[]
    ).map((r) => r.id)
    if (skillIds.length > 0) {
      const ph = skillIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM skill_tenant_access WHERE skill_id IN (${ph})`).run(...skillIds)
    }
    db.prepare('DELETE FROM skills WHERE tenant_id = ?').run(tenantId)

    // 12. Drop workspace_docs -- vec_workspace_docs has no trigger, sync manually before main delete.
    if (vecExtensionLoaded) {
      try { db.prepare('DELETE FROM vec_workspace_docs WHERE tenant_id = ?').run(tenantId) } catch { /* vec0 unavailable */ }
    }
    db.prepare('DELETE FROM workspace_docs WHERE tenant_id = ?').run(tenantId)

    // 13. Drop tenant_agent_availability (SQLite FK enforcement is off by default)
    db.prepare('DELETE FROM tenant_agent_availability WHERE tenant_id = ?').run(tenantId)

    // 14. Drop the tenant row
    db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId)

    return { memoriesDeleted: memIds.length }
  })()
}

// ── B2B Dashboard user provisioning ──────────────────────────────────────────

/** Admin-controlled user provisioning: explicit role + tenant_id, no first-user-wins. */
export function provisionDashboardUser(
  username: string,
  passwordHash: string,
  role: string,
  tenantId: string | null,
  email?: string | null,
  displayName?: string | null,
): DashboardUser {
  const now = Math.floor(Date.now() / 1000)
  const info = db
    .prepare('INSERT INTO dashboard_users (username, password_hash, role, tenant_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(username, passwordHash, role, tenantId, email ?? null, displayName ?? null, now, now)
  return { id: Number(info.lastInsertRowid), username, password_hash: passwordHash, role, tenant_id: tenantId, email: email ?? null, display_name: displayName ?? null, created_at: now, updated_at: now, disabled: 0 }
}

export function getDashboardUserById(id: number): DashboardUser | undefined {
  return db.prepare('SELECT * FROM dashboard_users WHERE id = ?').get(id) as DashboardUser | undefined
}

export interface ListUsersOpts {
  tenantId?: string | 'global'
  includeDisabled?: boolean
}

export function listDashboardUsersFiltered(opts: ListUsersOpts = {}): DashboardUserPublic[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (!opts.includeDisabled) {
    conditions.push('disabled = 0')
  }
  if (opts.tenantId === 'global') {
    conditions.push('tenant_id IS NULL')
  } else if (opts.tenantId) {
    conditions.push('tenant_id = ?')
    params.push(opts.tenantId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db
    .prepare(`SELECT id, username, role, tenant_id, email, display_name, created_at, updated_at, disabled FROM dashboard_users ${where} ORDER BY username COLLATE NOCASE`)
    .all(...params) as DashboardUserPublic[]
}

export interface AdminUserPatch {
  role?: string
  tenant_id?: string | null
  password_hash?: string
  disabled?: boolean
  email?: string | null
  display_name?: string | null
}

export function adminPatchDashboardUser(id: number, patch: AdminUserPatch): DashboardUser | null {
  const existing = getDashboardUserById(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.role !== undefined) { fields.push('role = ?'); params.push(patch.role) }
  if ('tenant_id' in patch) { fields.push('tenant_id = ?'); params.push(patch.tenant_id ?? null) }
  if (patch.password_hash !== undefined) { fields.push('password_hash = ?'); params.push(patch.password_hash) }
  if (patch.disabled !== undefined) { fields.push('disabled = ?'); params.push(patch.disabled ? 1 : 0) }
  if ('email' in patch) { fields.push('email = ?'); params.push(patch.email ?? null) }
  if ('display_name' in patch) { fields.push('display_name = ?'); params.push(patch.display_name ?? null) }
  params.push(id)
  db.prepare(`UPDATE dashboard_users SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return getDashboardUserById(id) ?? null
}

export function countActiveAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM dashboard_users WHERE role = 'admin' AND disabled = 0").get() as { c: number }).c
}

// Prefix that marks a message as a completion report / acknowledgement.
// Used by shouldNotifyDelegator to avoid ping-pong chains.
export const COMPLETION_REPORT_PREFIX = '[Eredmény]'

// ── Partner Senders ───────────────────────────────────────────────────────────

export interface PartnerSender {
  sender_id: string
  tenant_id: string
  display_name: string
  created_by: string
  created_at: number
  disabled_at: number | null
}

export function isAuthorizedPartnerSender(senderId: string, tenantId: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM partner_senders WHERE sender_id = ? AND tenant_id = ? AND disabled_at IS NULL'
  ).get(senderId, tenantId)
  return row != null
}

export function listPartnerSenders(tenantId?: string): PartnerSender[] {
  if (tenantId != null) {
    return db.prepare(
      'SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders WHERE tenant_id = ? ORDER BY created_at ASC'
    ).all(tenantId) as PartnerSender[]
  }
  return db.prepare(
    'SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders ORDER BY tenant_id, created_at ASC'
  ).all() as PartnerSender[]
}

export function createPartnerSender(senderId: string, tenantId: string, displayName: string, createdBy: string): PartnerSender {
  db.prepare(
    'INSERT INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, ?, ?)'
  ).run(senderId, tenantId, displayName, createdBy)
  return db.prepare(
    'SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders WHERE sender_id = ? AND tenant_id = ?'
  ).get(senderId, tenantId) as PartnerSender
}

export function disablePartnerSender(senderId: string, tenantId: string): boolean {
  const result = db.prepare(
    'UPDATE partner_senders SET disabled_at = unixepoch() WHERE sender_id = ? AND tenant_id = ? AND disabled_at IS NULL'
  ).run(senderId, tenantId)
  return result.changes > 0
}

// --- fleet_blackboard_history --------------------------------------------------

export interface BlackboardHistoryRow {
  id: number
  agent_id: string
  task_ref: string | null
  status: string
  summary: string
  created_at: number
}

export function insertBlackboardHistory(entry: {
  agent_id: string
  task_ref: string | null
  status: string
  summary: string
}): void {
  db.prepare(
    'INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary) VALUES (?, ?, ?, ?)'
  ).run(entry.agent_id, entry.task_ref, entry.status, entry.summary)
}

export function listBlackboardHistory(opts: {
  agent_id?: string
  since?: number
  limit?: number
} = {}): BlackboardHistoryRow[] {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const params: (string | number)[] = []
  if (opts.agent_id) { parts.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.since !== undefined) { parts.push('created_at >= ?'); params.push(opts.since) }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : ''
  params.push(limit)
  return db.prepare(
    `SELECT id, agent_id, task_ref, status, summary, created_at
     FROM fleet_blackboard_history ${where}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params) as BlackboardHistoryRow[]
}

export function pruneBlackboardHistory(ttlDays = 30): number {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return db.prepare('DELETE FROM fleet_blackboard_history WHERE created_at < ?').run(cutoff).changes
}

// Mark fleet_blackboard 'active' rows as 'stale' when they have not been
// updated for longer than the per-agent threshold. Returns how many rows were
// marked. Called by the blackboard-stale-sweeper on a background interval.
export function markBlackboardStale(
  thresholdsByAgent: Record<string, number>,
  defaultThresholdSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  const rows = db.prepare(
    `SELECT id, agent_id, task_ref, summary, updated_at FROM fleet_blackboard WHERE status = 'active'`,
  ).all() as { id: string; agent_id: string; task_ref: string | null; summary: string; updated_at: number }[]
  let marked = 0
  for (const row of rows) {
    const threshold = thresholdsByAgent[row.agent_id] ?? defaultThresholdSec
    if (nowSec - row.updated_at > threshold) {
      db.prepare(
        `UPDATE fleet_blackboard SET status = 'stale', updated_at = ? WHERE id = ?`,
      ).run(nowSec, row.id)
      insertBlackboardHistory({ agent_id: row.agent_id, task_ref: row.task_ref, status: 'stale', summary: row.summary })
      marked++
    }
  }
  return marked
}

export function getAgentTier(agentId: string): string {
  const row = db.prepare('SELECT tier FROM agent_blackboard_tier WHERE agent_id = ?').get(agentId) as { tier: string } | undefined
  return row?.tier ?? 'default'
}

export function getActiveBlackboardAgentIds(): string[] {
  const rows = db.prepare("SELECT DISTINCT agent_id FROM fleet_blackboard WHERE status = 'active'").all() as { agent_id: string }[]
  return rows.map((r) => r.agent_id)
}

// Remove fleet_blackboard rows that have been stuck in 'active' for longer
// than ttlHours without any agent updating them. These are orphaned entries
// from tasks whose sawTurn=false path cleared the watchdog without writing

export interface BlackboardRow {
  id: string
  agent_id: string
  task_ref: string | null
  status: 'active' | 'done' | 'blocked' | 'stale' | 'assigned'
  summary: string
  updated_at: number
}

export function findBlackboardRowByAgent(agent_id: string): BlackboardRow | undefined {
  return db.prepare('SELECT * FROM fleet_blackboard WHERE agent_id = ?').get(agent_id) as BlackboardRow | undefined
}

// Upsert a fleet blackboard row for agent_id, writing a history entry only
// when the status, summary, or task_ref actually changes.
export function upsertBlackboard(
  agent_id: string,
  data: { task_ref?: string | null; status?: string; summary: string },
): BlackboardRow {
  const existing = db.prepare('SELECT * FROM fleet_blackboard WHERE agent_id = ?').get(agent_id) as BlackboardRow | undefined
  const id = existing?.id ?? randomUUID().replace(/-/g, '').slice(0, 8)
  db.prepare(`
    INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(agent_id) DO UPDATE SET
      task_ref   = excluded.task_ref,
      status     = excluded.status,
      summary    = excluded.summary,
      updated_at = unixepoch()
  `).run(id, agent_id, data.task_ref ?? null, data.status ?? 'active', data.summary)
  const row = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get(id) as BlackboardRow
  const changed = !existing ||
    existing.status !== row.status ||
    existing.summary !== row.summary ||
    (existing.task_ref ?? null) !== (row.task_ref ?? null)
  if (changed) {
    insertBlackboardHistory({ agent_id: row.agent_id, task_ref: row.task_ref, status: row.status, summary: row.summary })
  }
  return row
}

// ── Tenant-agent availability (deny-by-default opt-in matrix) ─────────────────

export interface TenantAgentAvailability {
  tenant_id: string
  agent_id: string
  enabled: 0 | 1
  updated_at: number
}

/** List all availability rows for a tenant (enabled + disabled). */
export function listTenantAgentAvailability(tenantId: string): TenantAgentAvailability[] {
  return db
    .prepare('SELECT tenant_id, agent_id, enabled, updated_at FROM tenant_agent_availability WHERE tenant_id = ? ORDER BY agent_id')
    .all(tenantId) as TenantAgentAvailability[]
}

/** Upsert a (tenant, agent) availability row. Returns the new row. */
export function setTenantAgentAvailability(tenantId: string, agentId: string, enabled: boolean): TenantAgentAvailability {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
      enabled    = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(tenantId, agentId, enabled ? 1 : 0, now)
  return db.prepare('SELECT tenant_id, agent_id, enabled, updated_at FROM tenant_agent_availability WHERE tenant_id = ? AND agent_id = ?').get(tenantId, agentId) as TenantAgentAvailability
}

/** Check if an agent is explicitly enabled for a tenant. */
export function isTenantAgentEnabled(tenantId: string, agentId: string): boolean {
  const row = db
    .prepare('SELECT enabled FROM tenant_agent_availability WHERE tenant_id = ? AND agent_id = ?')
    .get(tenantId, agentId) as { enabled: number } | undefined
  return row?.enabled === 1
}

// ---------------------------------------------------------------------------
// Schedules (SQL-backed, replaces file-based scheduled-tasks-io)
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  id: string
  prompt: string
  description: string
  schedule: string
  agent: string
  type: 'task' | 'heartbeat' | 'command'
  enabled: number
  tenant_id: string | null
  skip_if_busy: number
  force_send: number
  target_session: string | null
  command: string | null
  timeout_ms: number | null
  fail_threshold: number | null
  pre_check: string | null
  catch_up_max_age_minutes: number | null
  stuck_after_minutes: number | null
  requires: string | null   // JSON blob
  created_at: number
  updated_at: number
}

export function countSchedules(): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM schedules').get() as { n: number }
  return row.n
}

export function listSchedulesFromDb(opts: { tenantId?: string | null; includeFleet?: boolean } = {}): ScheduleRow[] {
  if (opts.tenantId !== undefined && opts.tenantId !== null) {
    // Non-admin: only their own tenant's tasks
    return db.prepare('SELECT * FROM schedules WHERE tenant_id = ? ORDER BY created_at DESC').all(opts.tenantId) as ScheduleRow[]
  }
  if (opts.includeFleet) {
    // Admin with no filter: all rows
    return db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as ScheduleRow[]
  }
  // Admin with fleet-only: tenant_id IS NULL
  return db.prepare('SELECT * FROM schedules WHERE tenant_id IS NULL ORDER BY created_at DESC').all() as ScheduleRow[]
}

export function getScheduleFromDb(id: string): ScheduleRow | undefined {
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined
}

export interface UpsertScheduleOpts {
  prompt: string
  description: string
  schedule: string
  agent: string
  type: 'task' | 'heartbeat' | 'command'
  enabled: boolean
  tenant_id: string | null
  skip_if_busy: boolean
  force_send: boolean
  target_session?: string | null
  command?: string | null
  timeout_ms?: number | null
  fail_threshold?: number | null
  pre_check?: string | null
  catch_up_max_age_minutes?: number | null
  stuck_after_minutes?: number | null
  requires?: string | null
  created_at?: number
}

export function upsertSchedule(id: string, opts: UpsertScheduleOpts): ScheduleRow {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO schedules (
      id, prompt, description, schedule, agent, type, enabled, tenant_id,
      skip_if_busy, force_send, target_session, command, timeout_ms, fail_threshold,
      pre_check, catch_up_max_age_minutes, stuck_after_minutes, requires,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      prompt                   = excluded.prompt,
      description              = excluded.description,
      schedule                 = excluded.schedule,
      agent                    = excluded.agent,
      type                     = excluded.type,
      enabled                  = excluded.enabled,
      tenant_id                = excluded.tenant_id,
      skip_if_busy             = excluded.skip_if_busy,
      force_send               = excluded.force_send,
      target_session           = excluded.target_session,
      command                  = excluded.command,
      timeout_ms               = excluded.timeout_ms,
      fail_threshold           = excluded.fail_threshold,
      pre_check                = excluded.pre_check,
      catch_up_max_age_minutes = excluded.catch_up_max_age_minutes,
      stuck_after_minutes      = excluded.stuck_after_minutes,
      requires                 = excluded.requires,
      updated_at               = excluded.updated_at
  `).run(
    id, opts.prompt, opts.description, opts.schedule, opts.agent,
    opts.type, opts.enabled ? 1 : 0, opts.tenant_id ?? null,
    opts.skip_if_busy ? 1 : 0, opts.force_send ? 1 : 0,
    opts.target_session ?? null, opts.command ?? null,
    opts.timeout_ms ?? null, opts.fail_threshold ?? null,
    opts.pre_check ?? null, opts.catch_up_max_age_minutes ?? null,
    opts.stuck_after_minutes ?? null, opts.requires ?? null,
    opts.created_at ?? now, now,
  )
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
}

const PATCH_SCHEDULE_ALLOWED_COLS = new Set([
  'prompt', 'description', 'schedule', 'agent', 'type', 'enabled', 'tenant_id',
  'skip_if_busy', 'force_send', 'target_session', 'command', 'timeout_ms',
  'fail_threshold', 'pre_check', 'catch_up_max_age_minutes', 'stuck_after_minutes', 'requires',
])

export function patchSchedule(id: string, patch: Partial<Omit<UpsertScheduleOpts, 'created_at'>>): ScheduleRow | null {
  const existing = getScheduleFromDb(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  const boolCols = new Set(['enabled', 'skip_if_busy', 'force_send'])
  for (const [k, v] of Object.entries(patch)) {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase()
    if (!PATCH_SCHEDULE_ALLOWED_COLS.has(col)) continue
    sets.push(`${col} = ?`)
    vals.push(boolCols.has(col) && typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null))
  }
  vals.push(id)
  db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow
}

export function deleteSchedule(id: string): boolean {
  return db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0
}

export function setScheduleEnabled(id: string, enabled: boolean): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now, id).changes > 0
}

// INSERT OR IGNORE: seed a schedule from file only if it does not already exist
// in the DB. Safe to run on every boot -- never overwrites hand-edited rows.
export function seedScheduleIfAbsent(id: string, opts: UpsertScheduleOpts): boolean {
  const now = opts.created_at ?? Math.floor(Date.now() / 1000)
  const result = db.prepare(`
    INSERT OR IGNORE INTO schedules (
      id, prompt, description, schedule, agent, type, enabled, tenant_id,
      skip_if_busy, force_send, target_session, command, timeout_ms, fail_threshold,
      pre_check, catch_up_max_age_minutes, stuck_after_minutes, requires,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.prompt, opts.description, opts.schedule, opts.agent,
    opts.type, opts.enabled ? 1 : 0, opts.tenant_id ?? null,
    opts.skip_if_busy ? 1 : 0, opts.force_send ? 1 : 0,
    opts.target_session ?? null, opts.command ?? null,
    opts.timeout_ms ?? null, opts.fail_threshold ?? null,
    opts.pre_check ?? null, opts.catch_up_max_age_minutes ?? null,
    opts.stuck_after_minutes ?? null, opts.requires ?? null,
    now, now,
  )
  return result.changes > 0  // true = newly inserted, false = already existed (skipped)
}


// --- SQL-backed Skills (716) -----------------------------------------------

export interface SkillRow {
  id: string
  name: string
  description: string
  content: string
  tenant_id: string
  is_global: number
  created_by: string | null
  created_at: number
  updated_at: number
}

export interface CreateSkillOpts {
  id: string
  name: string
  description?: string
  content: string
  tenant_id: string
  is_global?: boolean
  created_by?: string | null
}

export function createSkill(opts: CreateSkillOpts): SkillRow {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id, opts.name, opts.description ?? '', opts.content,
    opts.tenant_id, opts.is_global ? 1 : 0, opts.created_by ?? null, now, now,
  )
  return getSkill(opts.id) as SkillRow
}

export function getSkill(id: string): SkillRow | undefined {
  return db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined
}

export function updateSkill(id: string, patch: { name?: string; description?: string; content?: string; is_global?: boolean }): SkillRow | undefined {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        vals.push(patch.name) }
  if (patch.description !== undefined) { sets.push('description = ?'); vals.push(patch.description) }
  if (patch.content !== undefined)     { sets.push('content = ?');     vals.push(patch.content) }
  if (patch.is_global !== undefined)   { sets.push('is_global = ?');   vals.push(patch.is_global ? 1 : 0) }
  vals.push(id)
  const changes = db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals).changes
  return changes > 0 ? getSkill(id) : undefined
}

export function deleteSkill(id: string): boolean {
  return db.prepare('DELETE FROM skills WHERE id = ?').run(id).changes > 0
}

/**
 * List skills visible to a caller:
 * - own skills (tenant_id = callerTenantId)
 * - skills explicitly granted via skill_tenant_access
 *
 * Fleet skills (tenant_id = 'fleet') are NOT included unless explicitly
 * granted. Pass callerTenantId = 'fleet' (admin) to see fleet skills.
 */
export function listSkillsForTenant(callerTenantId: string): SkillRow[] {
  return db.prepare(`
    SELECT s.* FROM skills s
    WHERE s.tenant_id = ?
    UNION
    SELECT s.* FROM skills s
    JOIN skill_tenant_access sta ON sta.skill_id = s.id
    WHERE sta.tenant_id = ?
    ORDER BY name
  `).all(callerTenantId, callerTenantId) as SkillRow[]
}

/** Admin: list all skills regardless of tenant. */
export function listAllSkills(): SkillRow[] {
  return db.prepare('SELECT * FROM skills ORDER BY tenant_id, name').all() as SkillRow[]
}

export interface SkillTenantAccessRow {
  skill_id: string
  tenant_id: string
  granted_by: string | null
  granted_at: number
}

export function grantSkillAccess(skillId: string, tenantId: string, grantedBy?: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO skill_tenant_access (skill_id, tenant_id, granted_by, granted_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_id, tenant_id) DO NOTHING
  `).run(skillId, tenantId, grantedBy ?? null, now)
}

export function revokeSkillAccess(skillId: string, tenantId: string): boolean {
  return db.prepare('DELETE FROM skill_tenant_access WHERE skill_id = ? AND tenant_id = ?').run(skillId, tenantId).changes > 0
}

export function listSkillAccess(skillId: string): SkillTenantAccessRow[] {
  return db.prepare('SELECT * FROM skill_tenant_access WHERE skill_id = ?').all(skillId) as SkillTenantAccessRow[]
}

// INSERT OR IGNORE: materialize a file-based skill only if no row with this id
// exists yet. Safe to run repeatedly -- never overwrites hand-edited DB rows.
export function seedSkillIfAbsent(opts: {
  id: string
  name: string
  description: string
  content: string
  tenant_id: string
  is_global: boolean
  created_at?: number
}): boolean {
  const now = opts.created_at ?? Math.floor(Date.now() / 1000)
  const result = db.prepare(`
    INSERT OR IGNORE INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(opts.id, opts.name, opts.description, opts.content, opts.tenant_id, opts.is_global ? 1 : 0, now, now)
  return result.changes > 0
}

export function countSkills(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n
}

