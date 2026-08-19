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
  // Create the tmp file at the requested mode from the FIRST byte. Writing it
  // mode-less and chmod-ing afterwards leaves a short-lived tmp that already
  // holds the full (possibly credential) content at the umask default (0644)
  // in the same directory as the protected target -- a world-readable window
  // (VAULTMODE818). The chmod stays as a belt-and-suspenders: writeFileSync's
  // mode is still reduced by the umask, so for modes with bits the umask would
  // strip the explicit chmod enforces the exact value.
  writeFileSync(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined)
  if (opts.mode !== undefined) {
    try { chmodSync(tmp, opts.mode) } catch { /* best-effort */ }
  }
  renameSync(tmp, path)
}
