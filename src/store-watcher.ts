import { watch, statSync } from 'node:fs'
import { basename } from 'node:path'
import { STORE_DIR } from './config.js'
import { logStoreFileEvent } from './db.js'
import { logger } from './logger.js'

// Files whose presence we record but whose content must never be logged.
// Even the audit entry for these is flagged is_sensitive=1 so the UI can
// render a sanitised label rather than showing path components that might
// hint at secret values.
const SENSITIVE_NAMES = new Set(['.dashboard-token', 'vault.json', '.vault-key'])

// Atomic-write temp files (our own tmp-file+rename pattern,
// `<name>.<pid>.<ts>.<hex>.tmp`, see atomic-write.ts) and migration artefacts:
// ignore them so the audit log doesn't double-count every settings save as
// both a temp write and a final rename. Ignoring the temp event also matters
// for attribution: the watch callback consumes the actor slot on the first
// non-ignored event, so if the temp event were logged it would steal the
// actor and leave the real (renamed) file with a null agent.
const IGNORE_RE = /\.tmp$|\.tmp\.[a-f0-9]+$|\.migrated$|\.bak$/

// --- Agent attribution slot ---
// Node.js is single-threaded; the HTTP request handler sets this before
// the file write, and the fs.watch callback (which fires in the next
// event-loop tick) reads and clears it. Because requests are serialised
// on the event loop, there is no race between two concurrent writes in
// practice. For writes that originate outside the process (e.g. external
// tools writing to store/), the slot stays null -> stored as null.
let currentWriteActor: string | null = null

export function setStoreWriteActor(actor: string): void {
  currentWriteActor = actor
}

export function clearStoreWriteActor(): void {
  currentWriteActor = null
}

let watcher: ReturnType<typeof watch> | null = null

// fs.watch fires the same (eventType, filename) several times for a single
// logical write (especially the rename half of an atomic write), which would
// otherwise produce duplicate audit rows -- and since the first event consumes
// the actor slot, the duplicates would be logged with a null agent. Collapse
// repeats of the same path+event within a short window into one entry.
const DEDUP_MS = 1000
const recentEvents = new Map<string, number>()

export function startStoreWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(STORE_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      if (IGNORE_RE.test(filename)) return
      const rel = filename.replace(/\\/g, '/')
      const now = Date.now()
      const dedupKey = `${eventType}:${rel}`
      const last = recentEvents.get(dedupKey)
      if (last !== undefined && now - last < DEDUP_MS) return
      recentEvents.set(dedupKey, now)
      // Prune stale dedup entries so the map cannot grow without bound.
      if (recentEvents.size > 200) {
        for (const [k, t] of recentEvents) if (now - t >= DEDUP_MS) recentEvents.delete(k)
      }
      const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0
      // Consume the actor slot: the caller set it just before writing.
      const agent = currentWriteActor
      currentWriteActor = null
      let fileSize: number | null = null
      if (eventType === 'change') {
        try {
          fileSize = statSync(`${STORE_DIR}/${rel}`).size
        } catch { /* file may have been deleted by the time we stat */ }
      }
      try {
        logStoreFileEvent(rel, eventType, isSensitive, fileSize, agent)
      } catch (err) {
        logger.warn({ err, rel }, 'store-watcher: failed to log event')
      }
    })
    logger.info({ dir: STORE_DIR }, 'Store file watcher started')
  } catch (err) {
    // Non-fatal: the rest of the dashboard works fine without store auditing.
    logger.warn({ err }, 'Store file watcher failed to start')
  }
}

export function stopStoreWatcher(): void {
  if (!watcher) return
  try { watcher.close() } catch { /* best-effort */ }
  watcher = null
}
