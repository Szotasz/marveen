import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { getDb, runLinkMaintenance } from '../db.js'
import { logger } from '../logger.js'
import {
  ALLOWED_EXTENSIONS,
  BLOCKED_EXTENSIONS,
  BLOCKED_BASENAMES,
  MAX_CONTENT_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_RUN,
  MAX_TOTAL_CONTENT_BYTES,
  MAX_CONCURRENT_READS,
} from './import-config.js'
import { HTML_LIKE_EXTS, stripMarkup } from './import-utils.js'

// ── Secret-gate patterns ─────────────────────────────────────────────────────
// Matches API tokens, private keys, passwords and similar credentials that must
// not be stored in the memory database.
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-_.]+/i,
  /sk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]+KEY-----/,
  /password\s*[:=]\s*\S+/i,
  /passwd\s*[:=]\s*\S+/i,
  /jelszó\s*:\s*\S+/i,
  /token\s*[:=]\s*\S+/i,
  /\.dashboard-token/,
  /api[_-]?key\s*[:=]\s*\S+/i,
  // IBAN-like: HU + 2 digits then groups of 4
  /\bHU\d{2}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}\b/,
]

function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(content))
}

// ── File type guards ─────────────────────────────────────────────────────────
function isAllowedFile(filePath: string): { ok: boolean; reason?: string } {
  const name = basename(filePath)
  const nameNoExt = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
  const ext = extname(name).slice(1).toLowerCase()

  if (BLOCKED_BASENAMES.has(name) || BLOCKED_BASENAMES.has(nameNoExt)) {
    return { ok: false, reason: 'blocked-basename' }
  }
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'blocked-extension' }
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'unsupported-extension' }
  }
  return { ok: true }
}

// ── Auto-keywords ─────────────────────────────────────────────────────────────
export function extractKeywords(content: string, fileName: string): string {
  // Try YAML front matter tags first (md/mdx files)
  const fmMatch = content.match(/^---[\s\S]*?tags:\s*\[([^\]]+)\][\s\S]*?---/i)
  if (fmMatch) {
    return fmMatch[1].replace(/['"\s]/g, '').replace(/,/g, ', ').trim()
  }
  // Fall back: first 20 space-separated tokens from content + the filename stem.
  // Use a Unicode-aware split so accented letters (á, é, ő, ű, ...) stay inside
  // words instead of acting as separators; the old ASCII \w class treated every
  // accented char as a break, shattering Hungarian words into 1-2 letter shards.
  // Drop <2-char tokens so those shards never surface as keyword tags.
  const stem = basename(fileName, extname(fileName))
  const words = content
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 20)
  if (stem) words.unshift(stem)
  return [...new Set(words)].slice(0, 20).join(', ')
}

// ── Mutex: one running scan per source ───────────────────────────────────────
const runningScans = new Set<string>()

// ── Total content size soft cap ───────────────────────────────────────────────
function getTotalImportSize(): number {
  const db = getDb()
  const row = db.prepare("SELECT SUM(LENGTH(content)) AS s FROM import_memories").get() as { s: number | null }
  return row.s ?? 0
}

// ── DB helpers ────────────────────────────────────────────────────────────────
type ImportSource = {
  id: string; type: string; path: string; label: string | null
  interval_hours: number; enabled: number; last_run_at: number | null
}

function getEnabledSources(): ImportSource[] {
  return getDb().prepare("SELECT * FROM import_sources WHERE enabled = 1").all() as ImportSource[]
}

function upsertImportMemory(
  sourceId: string,
  filePath: string,
  fileName: string,
  hash: string,
  content: string,
  keywords: string,
  now: number,
): 'added' | 'updated' | 'hash_match' {
  const db = getDb()
  const existing = db.prepare(
    "SELECT id, content_hash, memory_shadow_id FROM import_memories WHERE source_id = ? AND file_path = ?"
  ).get(sourceId, filePath) as { id: string; content_hash: string; memory_shadow_id: number | null } | undefined

  if (existing) {
    if (existing.content_hash === hash) {
      db.prepare("UPDATE import_memories SET last_seen_at = ? WHERE id = ?").run(now, existing.id)
      return 'hash_match'
    }
    db.prepare(`
      UPDATE import_memories SET content_hash = ?, content = ?, keywords = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(hash, content, keywords, now, now, existing.id)
    if (existing.memory_shadow_id) {
      // Keep shadow row in sync with updated content
      db.prepare('UPDATE memories SET content = ?, keywords = ?, updated_at = ? WHERE id = ?')
        .run(content, keywords, now, existing.memory_shadow_id)
    } else {
      // Create missing shadow row (defensive: migration backfill covers existing rows).
      // agent_id='import' is the discriminator; category='warm' satisfies the CHECK
      // constraint; chat_id and sector are sentinel values for NOT NULL columns.
      const sr = db.prepare(
        `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at)
         VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?) RETURNING id`
      ).get(content, keywords, now, now, now) as { id: number }
      db.prepare('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?').run(sr.id, existing.id)
    }
    return 'updated'
  }

  const id = createHash('sha256').update(`${sourceId}:${filePath}`).digest('hex').slice(0, 16)
  db.prepare(`
    INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceId, filePath, fileName, hash, content, keywords, now, now, now)
  // Create shadow row so the main embedding and link pipelines pick this up.
  // agent_id='import' is the discriminator; category='warm' satisfies the CHECK constraint.
  const sr = db.prepare(
    `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at)
     VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?) RETURNING id`
  ).get(content, keywords, now, now, now) as { id: number }
  db.prepare('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?').run(sr.id, id)
  return 'added'
}

function writeAuditLog(
  sourceId: string,
  runAt: number,
  counts: {
    scanned: number; added: number; updated: number
    skippedHash: number; skippedSecret: number; skippedSize: number; skippedType: number
  },
  error?: string,
): void {
  getDb().prepare(`
    INSERT INTO import_audit_log
      (source_id, run_at, files_scanned, files_added, files_updated,
       files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sourceId, runAt,
    counts.scanned, counts.added, counts.updated,
    counts.skippedHash, counts.skippedSecret, counts.skippedSize, counts.skippedType,
    error ?? null,
  )
}

// ── Local FS connector ────────────────────────────────────────────────────────
function collectLocalFiles(dirPath: string, results: string[], depth = 0): void {
  if (depth > 20) return // guard against symlink cycles
  if (!existsSync(dirPath)) return
  const entries = readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      collectLocalFiles(full, results, depth + 1)
    } else if (entry.isFile()) {
      results.push(full)
    }
  }
}

async function crawlLocalSource(
  source: ImportSource,
  totalSizeBefore: number,
): Promise<{ added: number; updated: number; skippedHash: number; skippedSecret: number; skippedSize: number; skippedType: number; scanned: number }> {
  const counts = { added: 0, updated: 0, skippedHash: 0, skippedSecret: 0, skippedSize: 0, skippedType: 0, scanned: 0 }
  const now = Math.floor(Date.now() / 1000)
  let totalSize = totalSizeBefore

  const allFiles: string[] = []
  collectLocalFiles(source.path, allFiles)

  const files = allFiles.slice(0, MAX_FILES_PER_RUN)

  // Process in batches of MAX_CONCURRENT_READS
  for (let i = 0; i < files.length; i += MAX_CONCURRENT_READS) {
    if (totalSize >= MAX_TOTAL_CONTENT_BYTES) {
      logger.warn({ sourceId: source.id }, 'Import soft cap reached; stopping scan')
      break
    }

    const batch = files.slice(i, i + MAX_CONCURRENT_READS)
    await Promise.all(batch.map(async (filePath) => {
      counts.scanned++

      const fileGuard = isAllowedFile(filePath)
      if (!fileGuard.ok) { counts.skippedType++; return }

      let size: number
      try { size = statSync(filePath).size } catch { counts.skippedType++; return }
      if (size > MAX_FILE_SIZE_BYTES) { counts.skippedSize++; return }

      let raw: string
      try { raw = readFileSync(filePath, 'utf-8') } catch { counts.skippedType++; return }

      if (containsSecret(raw)) { counts.skippedSecret++; return }

      const fileExt = extname(filePath).toLowerCase()
      const stripped = HTML_LIKE_EXTS.has(fileExt) ? stripMarkup(raw) : raw
      const content = stripped.length > MAX_CONTENT_BYTES
        ? stripped.slice(0, MAX_CONTENT_BYTES) + '\n[truncated]'
        : stripped

      const hash = createHash('sha256').update(raw).digest('hex')
      const keywords = extractKeywords(content, basename(filePath))

      const result = upsertImportMemory(source.id, filePath, basename(filePath), hash, content, keywords, now)
      if (result === 'added') { counts.added++; totalSize += content.length }
      else if (result === 'updated') { counts.updated++ }
      else { counts.skippedHash++ }
    }))
  }

  return counts
}

// ── Google Drive connector ────────────────────────────────────────────────────
async function crawlGdriveSource(
  source: ImportSource,
  totalSizeBefore: number,
): Promise<{ added: number; updated: number; skippedHash: number; skippedSecret: number; skippedSize: number; skippedType: number; scanned: number }> {
  const counts = { added: 0, updated: 0, skippedHash: 0, skippedSecret: 0, skippedSize: 0, skippedType: 0, scanned: 0 }
  const now = Math.floor(Date.now() / 1000)
  let totalSize = totalSizeBefore

  // Dynamic import so the connector is optional; if the MCP is unavailable
  // the crawl logs a warning and returns empty counts.
  let listFolder: ((id: string) => Promise<{ id: string; name: string; mimeType: string }[]>) | null = null
  let readFile: ((id: string) => Promise<string>) | null = null

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js' as any)
    void Client // suppress unused; the real integration uses the MCP session
    // TODO: wire to the live MCP session when the Google Drive MCP is available.
    logger.warn({ sourceId: source.id }, 'Google Drive MCP connector: not yet wired to live session; skipping')
    return counts
  } catch {
    logger.warn({ sourceId: source.id }, 'Google Drive MCP not available; skipping')
    return counts
  }
}

// ── SharePoint connector ──────────────────────────────────────────────────────
// NOTE: If connecting to a corporate SharePoint, ensure the organisation's
// IT/data-protection policy permits copying content into a personal AI system.
// The system does not manage the classification level of the source material.
// Required Microsoft Graph scope: Sites.Read.All (read-only minimum).
async function crawlSharePointSource(
  source: ImportSource,
  _totalSizeBefore: number,
): Promise<{ added: number; updated: number; skippedHash: number; skippedSecret: number; skippedSize: number; skippedType: number; scanned: number }> {
  const counts = { added: 0, updated: 0, skippedHash: 0, skippedSecret: 0, skippedSize: 0, skippedType: 0, scanned: 0 }
  // TODO: wire to the Microsoft Graph MCP when available.
  logger.warn({ sourceId: source.id }, 'SharePoint MCP connector: not yet wired to live session; skipping')
  return counts
}

// ── Main crawl entry point ────────────────────────────────────────────────────
export async function crawlSource(sourceId: string): Promise<void> {
  if (runningScans.has(sourceId)) {
    logger.info({ sourceId }, 'Import crawl already running; skipping')
    return
  }

  const db = getDb()
  const source = db.prepare("SELECT * FROM import_sources WHERE id = ?").get(sourceId) as ImportSource | undefined
  if (!source) { logger.warn({ sourceId }, 'Import source not found'); return }

  runningScans.add(sourceId)
  const runAt = Math.floor(Date.now() / 1000)
  let error: string | undefined

  try {
    const totalSizeBefore = getTotalImportSize()
    let counts: Awaited<ReturnType<typeof crawlLocalSource>>

    if (source.type === 'local') {
      counts = await crawlLocalSource(source, totalSizeBefore)
    } else if (source.type === 'gdrive') {
      counts = await crawlGdriveSource(source, totalSizeBefore)
    } else if (source.type === 'sharepoint') {
      counts = await crawlSharePointSource(source, totalSizeBefore)
    } else {
      throw new Error(`Unknown source type: ${source.type}`)
    }

    writeAuditLog(source.id, runAt, {
      scanned: counts.scanned,
      added: counts.added,
      updated: counts.updated,
      skippedHash: counts.skippedHash,
      skippedSecret: counts.skippedSecret,
      skippedSize: counts.skippedSize,
      skippedType: counts.skippedType,
    })

    logger.info({
      sourceId, type: source.type,
      added: counts.added, updated: counts.updated,
      skippedHash: counts.skippedHash, skippedSecret: counts.skippedSecret,
      skippedSize: counts.skippedSize, skippedType: counts.skippedType,
    }, 'Import scan complete')

    // Newly added/updated shadow memories carry no embedding yet, and the memory
    // graph links are built purely from embedding similarity. Trigger a link
    // maintenance pass (it backfills embeddings for recently-updated rows lacking
    // one, then rebuilds neighbor links) so imported docs join the graph without a
    // manual step. Bounded to the last day's updates; fire-and-forget, non-fatal.
    if (counts.added + counts.updated > 0) {
      runLinkMaintenance({ maxAge: 86400 }).catch(err =>
        logger.warn(
          { sourceId, err: err instanceof Error ? err.message : String(err) },
          'Import: post-crawl link maintenance failed',
        ))
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    logger.error({ sourceId, err }, 'Import crawl error')
    writeAuditLog(source.id, runAt, { scanned: 0, added: 0, updated: 0, skippedHash: 0, skippedSecret: 0, skippedSize: 0, skippedType: 0 }, error)
  } finally {
    runningScans.delete(sourceId)
    db.prepare("UPDATE import_sources SET last_run_at = ? WHERE id = ?").run(runAt, sourceId)
  }
}

// ── Scheduler: check all enabled sources and run overdue ones ─────────────────
export async function runDueImports(): Promise<void> {
  const sources = getEnabledSources()
  const now = Math.floor(Date.now() / 1000)

  for (const source of sources) {
    const intervalSec = source.interval_hours * 3600
    const lastRun = source.last_run_at ?? 0
    if (now - lastRun >= intervalSec) {
      // Non-blocking: each source runs independently
      crawlSource(source.id).catch(err => logger.error({ sourceId: source.id, err }, 'Unhandled crawl error'))
    }
  }
}

// ── Interval runner ───────────────────────────────────────────────────────────
let crawlerInterval: ReturnType<typeof setInterval> | null = null

export function startImportCrawler(): void {
  if (crawlerInterval) return
  // Check every 15 minutes; individual sources compare against their own interval
  crawlerInterval = setInterval(() => { void runDueImports() }, 15 * 60_000)
  // Also run once shortly after startup to catch anything overdue
  setTimeout(() => { void runDueImports() }, 30_000)
}

export function stopImportCrawler(): void {
  if (crawlerInterval) { clearInterval(crawlerInterval); crawlerInterval = null }
}
