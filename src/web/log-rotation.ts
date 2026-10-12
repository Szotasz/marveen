import { existsSync, statSync, readFileSync, writeFileSync, renameSync, truncateSync, unlinkSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

// Log rotation for the launcher-redirected logs (LOGROTATE910, 2026-09-10).
//
// Why copytruncate and not mv: every writer of these files holds them as its
// own STDOUT/STDERR, opened ONCE at process start by the launcher (launchd
// StandardOutPath on macOS, systemd StandardOutput=append: on Linux, start.sh
// >> redirect). An mv-based rotation silently breaks that shape: the process
// keeps writing into the moved inode, the "rotated" file receives nothing and
// the old one keeps growing invisibly. Copy-then-truncate leaves the fd alone.
//
// Why truncate is safe here (measured on the live host, lsof FILE-FLAG): the
// writers hold the fd with O_APPEND ("AP"), so after the truncate every write
// lands at the new EOF. A non-append writer would instead keep its old offset
// and turn the file sparse -- which is why start.sh's redirect is >> (append),
// and why that redirect must never regress to >.
//
// STATED LOSS: lines written between the copy and the truncate are lost from
// both files. Measured write rate on the busiest log (dashboard.log,
// 2026-09-10): ~21 bytes/s peak, ~0.4-1.8 MB/day -- the copy-to-truncate
// window is well under a second, so the expected loss is 0-1 line per
// rotation, a few rotations per month. If a future writer becomes high-volume
// and buffered, this trade-off must be re-measured, not assumed.
//
// COVERED FILES ARE AN EXPLICIT LIST, deliberately: store/ also holds
// append-only ledgers (provenance-flagged.log, egress-blocked.log, ...) whose
// full history is the point -- a generic *.log sweep would rotate evidence.
// If a new launcher-redirected log appears, EXTEND THIS LIST, otherwise its
// growth is silent (the same discipline as the installer drift sentinel's
// covered-files list).
export const ROTATED_LOG_NAMES = [
  'dashboard.log',
  'dashboard.error.log',
  'channel-coordinator.log',
  'channel-coordinator.error.log',
  'channels.log',
  'channels.error.log',
] as const

// Retention, named in numbers (owner-readable, not "eleg lesz"): rotate a file
// once it exceeds 20 MB, keep 5 gzipped generations. At the measured rates
// that is roughly 2-7 weeks per generation on the busiest log, i.e. months of
// history, in at most ~6 files per log (live + 5 archives).
export const MAX_LOG_BYTES = 20 * 1024 * 1024
export const KEEP_GENERATIONS = 5

export const LOG_ROTATION_SWEEP_MS = 60 * 60 * 1000 // hourly size check

export interface RotationResult {
  rotated: boolean
  sizeBytes: number
}

/**
 * Rotate one log file if it exceeds maxBytes: shift the .N.gz generations up
 * (dropping the oldest), gzip the current content to .1.gz, then truncate the
 * live file to zero. The live fd of the writing process is never touched.
 */
export function rotateLogFile(
  path: string,
  opts: { maxBytes?: number; keep?: number } = {},
): RotationResult {
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES
  const keep = opts.keep ?? KEEP_GENERATIONS
  if (!existsSync(path)) return { rotated: false, sizeBytes: 0 }
  const sizeBytes = statSync(path).size
  if (sizeBytes <= maxBytes) return { rotated: false, sizeBytes }

  // Shift generations from the oldest down, so .1.gz is free for the new one.
  const gen = (n: number) => `${path}.${n}.gz`
  const oldest = gen(keep)
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let n = keep - 1; n >= 1; n--) {
    if (existsSync(gen(n))) renameSync(gen(n), gen(n + 1))
  }

  // Copy (compressed), then truncate. Write the archive via a temp name +
  // rename so a crash mid-write never leaves a half .1.gz masquerading as a
  // complete generation.
  const tmp = `${gen(1)}.tmp`
  writeFileSync(tmp, gzipSync(readFileSync(path)))
  renameSync(tmp, gen(1))
  truncateSync(path, 0)
  return { rotated: true, sizeBytes }
}

/** Run one sweep over the covered logs. Returns the rotated file names. */
export function runLogRotationSweep(
  storeDir: string = STORE_DIR,
  opts: { maxBytes?: number; keep?: number } = {},
): string[] {
  const rotated: string[] = []
  for (const name of ROTATED_LOG_NAMES) {
    const path = join(storeDir, name)
    try {
      const res = rotateLogFile(path, opts)
      if (res.rotated) {
        rotated.push(name)
        logger.info({ file: name, sizeBytes: res.sizeBytes }, 'Log rotated (copytruncate)')
      }
    } catch (err) {
      // A rotation failure must never take the service down; the file simply
      // keeps growing until the next sweep and the error says why.
      logger.error({ err, file: name }, 'Log rotation failed')
    }
  }
  return rotated
}
