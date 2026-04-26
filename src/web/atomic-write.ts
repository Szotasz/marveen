import { writeFileSync, chmodSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

// Atomic write: write to a sibling tmp file and rename over the target, so a
// crash/kill mid-write can never leave a zero-byte or half-written state file.
// Use this for anything the dashboard depends on surviving a restart
// (dashboard-token, agent CLAUDE.md / SOUL.md, telegram env + access.json).
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data)
  if (opts.mode !== undefined) {
    try { chmodSync(tmp, opts.mode) } catch { /* best-effort */ }
  }
  renameSync(tmp, path)
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}
