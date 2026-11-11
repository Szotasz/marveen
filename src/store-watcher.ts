import { watch, statSync, lstatSync, readdirSync, type FSWatcher } from 'node:fs'
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
  '.dashboard-token', '.vault-key', 'vault.json', '.claude-oauth-token',
  // Federation config + inbound peer token (written by /api/federation/peers)
  'federation.json', '.federation-token',
  // Capability-summary cache (written by the capability-summary runner);
  // capability text, not a secret -- deliberately NOT in SENSITIVE_NAMES.
  'capability-summaries.json',
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
const SENSITIVE_NAMES = new Set(['.dashboard-token', 'vault.json', '.vault-key', '.claude-oauth-token', '.federation-token', 'federation.json'])

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

function scanStore(dir: string, relBase: string = '', excluded: ReadonlySet<string> = new Set()): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (relBase === '' && excluded.has(entry.name) && entry.isDirectory()) continue
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        scanStore(join(dir, entry.name), rel, excluded)
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

let watcher: FSWatcher | null = null
const subWatchers = new Map<string, FSWatcher>()

// SYSTEM_DIR_PREFIXES only filters audit rows; the tree is still watched.
// STORE_WATCH_EXCLUDE removes a top-level DIRECTORY tree from both the scan and the watch; a top-level file
// with an excluded name is still scanned and logged.
// Whole-directory denylist prefixes, for trees whose filenames vary (so a
// fixed-name SYSTEM_FILES entry can't cover them). scheduled-runs/ is the
// SCHEDPROMPTREF917 snapshot dir: ~100 new files/day by design (one per
// large-task fire), which would otherwise drown every real agent-created-file
// audit row in scheduler noise.
const SYSTEM_DIR_PREFIXES = ['scheduled-runs/']

function isSystemFile(rel: string): boolean {
  const name = basename(rel)
  if (SYSTEM_FILES.has(name) || SYSTEM_RE.test(name)) return true
  return SYSTEM_DIR_PREFIXES.some(prefix => rel.startsWith(prefix))
}

function handleWatchEvent(eventType: string, filename: string | null): void {
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
    // A directory is not a created file. On Linux the recursive watcher
    // emits 'rename' for every directory it walks while setting itself up,
    // and scanStore() only puts FILES into knownFiles, so without this
    // every directory under store/ was logged as a new file on every boot
    // (measured: 26 527 rows in one start, the same path 22 times, the
    // synchronous INSERTs blocking the event loop for ~20 s).
    // lstat, not stat: a symlink to a directory is an entry scanStore()
    // counts as a file, so a new one must still be logged. The delete
    // covers a known file replaced by a directory of the same name.
    if (lstatSync(`${STORE_DIR}/${rel}`).isDirectory()) {
      knownFiles.delete(rel)
      return
    }
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
}

export interface StoreWatcherOptions {
  exclude?: Iterable<string>
}

export function startStoreWatcher(opts: StoreWatcherOptions = {}): void {
  if (watcher) return

  const excluded = new Set(opts.exclude ?? [])
  knownFiles = new Set<string>()
  scanStore(STORE_DIR, '', excluded)

  // An unreadable subdirectory (another user's sandbox dir) makes the
  // recursive watcher emit 'error'; without a listener that is an
  // uncaughtException and the dashboard exits. Log once per (code, path), keep going.
  const reportedWatchErrors = new Set<string>()
  function attachWatchErrorListener(w: FSWatcher): void {
    w.on('error', (err: NodeJS.ErrnoException) => {
      const key = JSON.stringify([err?.code ?? null, err?.path ?? null])
      if (reportedWatchErrors.has(key)) return
      reportedWatchErrors.add(key)
      logger.warn({ code: err?.code, path: err?.path }, 'store-watcher: subdirectory not watchable, skipped')
    })
  }

  function startSubWatcher(name: string): void {
    try {
      const w = watch(join(STORE_DIR, name), { recursive: true }, (eventType, filename) =>
        handleWatchEvent(eventType, filename == null ? null : `${name}/${String(filename).replace(/\\/g, '/')}`))
      attachWatchErrorListener(w)
      subWatchers.set(name, w)
    } catch (err) {
      logger.warn({ err, dir: name }, 'store-watcher: subdirectory watch failed to start')
    }
  }

  function catchUpSubtree(top: string): void {
    function walk(dir: string, relBase: string): void {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const rel = `${relBase}/${entry.name}`
          if (entry.isDirectory()) {
            walk(join(dir, entry.name), rel)
          } else if (!knownFiles.has(rel)) {
            handleWatchEvent('rename', rel)
          }
        }
      } catch { /* non-fatal; directory may have disappeared */ }
    }
    walk(join(STORE_DIR, top), top)
  }

  try {
    if (excluded.size === 0) {
      watcher = watch(STORE_DIR, { recursive: true }, handleWatchEvent)
      attachWatchErrorListener(watcher)
    } else {
      watcher = watch(STORE_DIR, { recursive: false }, (eventType, filename) => {
        if (filename == null) return
        const rel = String(filename).replace(/\\/g, '/')
        const top = rel.split('/')[0]
        let isDir = false
        try {
          isDir = lstatSync(join(STORE_DIR, top)).isDirectory()
        } catch { /* gone: deleted or renamed away */ }
        if (isDir && excluded.has(top)) {
          // Consume the actor slot, as handleWatchEvent does for every event.
          // A file with this name may have been known before it became a directory.
          currentWriteActor = null
          knownFiles.delete(top)
          return
        }
        let startedSubWatcher = false
        if (eventType === 'rename') {
          if (isDir) {
            if (!subWatchers.has(top)) {
              startedSubWatcher = true
              startSubWatcher(top)
            }
          } else {
            const w = subWatchers.get(top)
            if (w) {
              try { w.close() } catch { /* best-effort */ }
              subWatchers.delete(top)
            }
          }
        }
        handleWatchEvent(eventType, rel)
        // Catch files created in the new directory before its watch was attached.
        if (startedSubWatcher) catchUpSubtree(top)
      })
      attachWatchErrorListener(watcher)
      for (const name of readdirSync(STORE_DIR)) {
        if (excluded.has(name)) continue
        try {
          if (lstatSync(join(STORE_DIR, name)).isDirectory()) startSubWatcher(name)
        } catch { /* entry may have disappeared since readdir */ }
      }
    }
    logger.info({ dir: STORE_DIR, knownCount: knownFiles.size, excluded: [...excluded], subWatchers: subWatchers.size }, 'Store file watcher started')
  } catch (err) {
    logger.warn({ err }, 'Store file watcher failed to start')
  }
}

export function stopStoreWatcher(): void {
  if (watcher) {
    try { watcher.close() } catch { /* best-effort */ }
  }
  for (const w of subWatchers.values()) {
    try { w.close() } catch { /* best-effort */ }
  }
  subWatchers.clear()
  watcher = null
}
