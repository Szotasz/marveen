import { writeFileSync, chmodSync, renameSync, openSync, fstatSync, fchmodSync, closeSync, constants as fsConstants } from 'node:fs'
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

// MCPJSON0600-1121: a .mcp.json can carry MCP server env (keys, tokens), so it is written owner-only (0600), and
// through the rename above, which replaces a symlink at the path instead of following it to another file.
export const MCP_JSON_MODE = 0o600
export function writeMcpJsonFile(path: string, data: string): void {
  atomicWriteFileSync(path, data, { mode: MCP_JSON_MODE })
}

/** An existing .mcp.json written before MCPJSON0600-1121 is 0644: narrow a regular file (never a symlink) to 0600.
 *  Returns whether it changed the mode; any error leaves the file as it is. */
export function tightenMcpJsonMode(path: string): boolean {
  // O_NOFOLLOW + fchmod on the opened descriptor: a path swapped for a symlink between a check and a chmod cannot
  // redirect the chmod to another file (the open itself refuses a symlink). O_NONBLOCK: opening a FIFO with no
  // writer for reading would block this synchronous call on Linux; the isFile check then rejects it.
  let fd: number | null = null
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077) === 0) return false
    fchmodSync(fd, MCP_JSON_MODE)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* already closed */ } }
  }
}
