// GROMZOAGENTPICK1101 (Samu 64526, Ábel 64474): an agent added from the dashboard gets its dashboard
// picture on Gromzo too. The dashboard sends it with mxd's own dash.sock verb (agent_avatar), which
// stores it in mxd's agent list and sets it on the agent's Matrix account (now, or at its next start).
//
// The file is the agent's own: agents/<slug>/avatar.<ext> sits in the agent's working directory, so the
// agent can write it. Reading it is therefore guarded (Dani 64485):
// - lstat, never followed: a symlink (or anything but a regular file) is refused, so it cannot point the
//   dashboard at another readable file and carry that to the team through mxd;
// - the size is checked BEFORE the read (mxd's limit, 2 MB), and the read itself goes through
//   O_NOFOLLOW and is bounded again (the file may change between the two);
// - the magic bytes are checked here too (PNG or JPEG, as mxd accepts), not only in mxd;
// - the path is built only from a slug the caller already checked (slugRefusal), through agentDir.
// Nothing here logs: the caller logs the slug and the size, never the bytes or the path.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** mxd agents_store AVATAR_MAX_BYTES. */
export const GROMZO_AVATAR_MAX_BYTES = 2 * 1024 * 1024
/** The names the dashboard's own avatar upload writes (routes/agents.ts), in its order. */
export const AVATAR_EXTS = ['.png', '.jpg', '.jpeg', '.webp'] as const

export type AvatarProblem = 'no_avatar' | 'avatar_not_a_file' | 'avatar_too_large' | 'avatar_format'
export type AvatarRead = { ok: true, bytes: Buffer } | { ok: false, code: AvatarProblem }

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG = Buffer.from([0xff, 0xd8, 0xff])

export function imageKind(b: Buffer): 'png' | 'jpg' | null {
  if (b.length < 8 || b.length > GROMZO_AVATAR_MAX_BYTES) return null
  if (b.subarray(0, 8).equals(PNG)) return 'png'
  if (b.subarray(0, 3).equals(JPEG)) return 'jpg'
  return null
}

/** The first avatar file of the agent (by the dashboard's own order), unread: what is wrong with it, or its path. */
function locate(dir: string): { path: string, size: number } | { code: AvatarProblem } {
  for (const ext of AVATAR_EXTS) {
    const path = join(dir, 'avatar' + ext)
    let st
    try { st = lstatSync(path) } catch { continue }
    if (!st.isFile()) return { code: 'avatar_not_a_file' }
    if (st.size > GROMZO_AVATAR_MAX_BYTES) return { code: 'avatar_too_large' }
    if (ext === '.webp') return { code: 'avatar_format' }
    return { path, size: st.size }
  }
  return { code: 'no_avatar' }
}

/** What would go wrong sending this agent's picture, without reading it (the list shows it); null = fine. */
export function avatarProblem(dir: string): AvatarProblem | null {
  const l = locate(dir)
  return 'code' in l ? l.code : null
}

/** Reads the agent's picture under the guards above. `dir` is agentDir(slug) of a checked slug. */
export function readAgentAvatar(dir: string): AvatarRead {
  const l = locate(dir)
  if ('code' in l) return { ok: false, code: l.code }
  let fd: number
  try { fd = openSync(l.path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { return { ok: false, code: 'avatar_not_a_file' } }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { ok: false, code: 'avatar_not_a_file' }
    if (st.size > GROMZO_AVATAR_MAX_BYTES) return { ok: false, code: 'avatar_too_large' }
    // One byte more than the limit: a file that grew after the stat is caught here, not sent cut.
    const buf = Buffer.alloc(GROMZO_AVATAR_MAX_BYTES + 1)
    let n = 0
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null)
      if (r === 0) break
      n += r
      if (n > GROMZO_AVATAR_MAX_BYTES) return { ok: false, code: 'avatar_too_large' }
    }
    const bytes = buf.subarray(0, n)
    return imageKind(bytes) ? { ok: true, bytes: Buffer.from(bytes) } : { ok: false, code: 'avatar_format' }
  } finally {
    closeSync(fd)
  }
}
