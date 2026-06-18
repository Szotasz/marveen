import { watch, statSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logStoreFileEvent } from './db.js'
import { logger } from './logger.js'

// --- System file denylist ---
// Only files NOT on this list (and not matching SYSTEM_RE) are logged.
// Everything else = Marveen-managed state that would produce noise.
// "Agent-created" files are those that remain after filtering.
const SYSTEM_FILES = new Set([
  // SQLite database
  'claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm',
  // Marveen runtime / scheduler state
  'schedule-last-run.json', 'external-ops-last-run',
  'kanban-audit-state.json',
  // Settings and config overrides written by dashboard routes
  'config-overrides.json', 'dashboard-settings.json',
  // Fleet and agent management
  'agents-desired.json', 'auto-restart.json', 'autonomy-config.json',
  // Auth and secrets
  '.dashboard-token', '.vault-key', 'vault.json',
  // Usage and keepalive
  'claude-usage.json', '.channel-keepalive', '.channel-last-respawn',
  // Known Marveen-written log files
  'channels.log', 'channels.error.log',
  'dashboard.log', 'dashboard.error.log',
  'update.log',
])

// Regex for system-generated filename patterns.
// Also covers atomic-write temp files (keep in sync with settings-store.ts).
const SYSTEM_RE = /\.pid$|\.tmp$|\.tmp\.[a-f0-9]+$|\.migrated$|\.bak$|^\.DS_Store$/

// Filenames whose presence is sensitive; the audit row is flagged so the UI
// can show a sanitised label instead of hinting at secret values.
const SENSITIVE_NAMES = new Set(['.dashboard-token', 'vault.json', '.vault-key'])

// --- Agent attribution slot ---
// Node.js is single-threaded; a route handler sets this before writing,
// the watch callback reads and clears it in the next event-loop tick.
// For direct writes (Bash/Write tool from outside the process), this stays
// null -- stored as null, shown as "ismeretlen" in the UI. There is no
// OS-level mechanism to identify the writer without a process audit daemon,
// so null is the honest and correct value.
let currentWriteActor: string | null = null

export function setStoreWriteActor(actor: string): void {
  currentWriteActor = actor
}

export function clearStoreWriteActor(): void {
  currentWriteActor = null
}

// --- Known-files tracking for creation detection ---
// Populated at watcher startup by scanning store/. A rename event for a path
// NOT in this set where the file NOW EXISTS means a new file was created.
let knownFiles = new Set<string>()

function scanStore(dir: string, relBase: string = ''): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        scanStore(join(dir, entry.name), rel)
      } else {
        knownFiles.add(rel)
      }
    }
  } catch { /* non-fatal; store may not exist yet */ }
}

// --- Dedup ---
// fs.watch fires the same (eventType, filename) multiple times for a single
// logical operation. Collapse repeats within a short window.
const DEDUP_MS = 1000
const recentEvents = new Map<string, number>()

let watcher: ReturnType<typeof watch> | null = null

function isSystemFile(rel: string): boolean {
  const name = basename(rel)
  return SYSTEM_FILES.has(name) || SYSTEM_RE.test(name)
}

export function startStoreWatcher(): void {
  if (watcher) return

  knownFiles = new Set<string>()
  scanStore(STORE_DIR)

  try {
    watcher = watch(STORE_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const rel = filename.replace(/\\/g, '/')

      // Consume (clear) the actor slot for ALL events, including system-file
      // events, so a slot set before a denylist-ed write cannot leak to the
      // next unrelated event.
      const agent = currentWriteActor
      currentWriteActor = null

      // Only rename events can indicate a new file. change = modification.
      if (eventType !== 'rename') return

      // Skip system and temp files -- Marveen's own runtime writes.
      if (isSystemFile(rel)) return

      // If the file no longer exists it was deleted or renamed away -- not a creation.
      let fileSize: number | null = null
      try {
        const st = statSync(`${STORE_DIR}/${rel}`)
        fileSize = st.size
      } catch {
        // File gone: deletion or rename-away. Update knownFiles and skip.
        knownFiles.delete(rel)
        return
      }

      // Already known → not a new creation (could be a rename-to-same or
      // replace; ignore to avoid false positives).
      if (knownFiles.has(rel)) return

      // Dedup: fs.watch may fire the rename event several times.
      const now = Date.now()
      const dedupKey = rel
      const last = recentEvents.get(dedupKey)
      if (last !== undefined && now - last < DEDUP_MS) return
      recentEvents.set(dedupKey, now)
      if (recentEvents.size > 200) {
        for (const [k, t] of recentEvents) if (now - t >= DEDUP_MS) recentEvents.delete(k)
      }

      // New file -- record it and mark as known.
      knownFiles.add(rel)
      const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0

      try {
        logStoreFileEvent(rel, 'create', isSensitive, fileSize, agent)
      } catch (err) {
        logger.warn({ err, rel }, 'store-watcher: failed to log new file event')
      }
    })
    logger.info({ dir: STORE_DIR, knownCount: knownFiles.size }, 'Store file watcher started')
  } catch (err) {
    logger.warn({ err }, 'Store file watcher failed to start')
  }
}

export function stopStoreWatcher(): void {
  if (!watcher) return
  try { watcher.close() } catch { /* best-effort */ }
  watcher = null
}
