import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentConfigRoot, listAgentNames } from '../agent-config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Read-only viewer for each agent's research/ folder (agents/<name>/research/,
// or the project root for the main agent). Mirrors routes/docs.ts: everything
// sits under /api/* (bearer-token gated), nothing is writable, and names are
// allowlisted to block path traversal.
//
// The listing recurses into subfolders, so a doc name is a RELATIVE PATH
// ("endgame2-hermes/nightly/foo.md"), not a bare filename. That breaks both of
// the flat-namespace defenses this file used to rely on -- a single NAME_RE
// over the whole name, and basename(name) === name -- because a legal name now
// contains "/". They are replaced by two independent layers:
//
//   1. isSafeRelPath(): every segment allowlisted separately, "." and ".."
//      rejected outright (note: they PASS the character allowlist, dots are in
//      it), only the last segment may be the .md file, bounded depth.
//   2. resolveInside(): realpath containment, which also covers symlinks that
//      point out of the tree.
//
// Layer 2 is measured against the RESOLVED research root, never against
// PROJECT_ROOT: in production marveen/research is itself a symlink to
// ~/research, so a repo-path containment check would resolve every real file
// as "outside" and silently serve an empty page.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const FILE_RE = /^[A-Za-z0-9._-]+\.md$/
const MAX_SEGMENTS = 4

function titleOf(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

function researchDir(agent: string): string {
  return join(agentConfigRoot(agent), 'research')
}

function isSafeSegment(name: string): boolean {
  return name !== '.' && name !== '..' && SEGMENT_RE.test(name)
}

function isSafeRelPath(name: string): boolean {
  const parts = name.split('/')
  if (parts.length < 1 || parts.length > MAX_SEGMENTS) return false
  const last = parts.length - 1
  return parts.every((p, i) =>
    i === last ? p !== '.' && p !== '..' && FILE_RE.test(p) : isSafeSegment(p),
  )
}

// Resolved absolute path of `target`, or null if it does not exist or escapes
// `realRoot` (already-resolved research root).
function resolveInside(realRoot: string, target: string): string | null {
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return null
  }
  const rel = relative(realRoot, real)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return real
}

function realResearchRoot(agent: string): string | null {
  try {
    return realpathSync(researchDir(agent))
  } catch {
    return null
  }
}

function walk(realRoot: string, rel: string, depth: number, out: string[]): void {
  if (depth > MAX_SEGMENTS) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(rel ? join(realRoot, rel) : realRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!isSafeSegment(e.name)) continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const real = resolveInside(realRoot, join(realRoot, childRel))
    if (!real) continue
    let st: import('node:fs').Stats
    try {
      st = statSync(real)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(realRoot, childRel, depth + 1, out)
    else if (st.isFile() && FILE_RE.test(e.name)) out.push(childRel)
  }
}

export async function tryHandleResearch(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/research' && method === 'GET') {
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    const result = agents.map(agent => {
      const realRoot = realResearchRoot(agent)
      const names: string[] = []
      if (realRoot) walk(realRoot, '', 1, names)
      const docs = names
        .map(name => {
          let title = name
          let ms = 0
          try {
            const file = join(realRoot!, name)
            title = titleOf(readFileSync(file, 'utf-8'), name)
            ms = statSync(file).mtimeMs
          } catch {
            /* keep filename as title */
          }
          return { name, title, ms }
        })
        .sort((a, b) => (b.ms - a.ms) || a.name.localeCompare(b.name))
        .map(({ name, title, ms }) => ({ name, title, updated: new Date(ms).toISOString().slice(0, 10) }))
      return { agent, docs }
    }).filter(a => a.docs.length > 0)
    json(res, result)
    return true
  }

  // The doc segment may carry "/" (percent-encoded by the client, raw if a
  // proxy normalized it), so it is matched greedily and validated after
  // decoding rather than constrained by the route pattern.
  const match = path.match(/^\/api\/research\/([^/]+)\/(.+)$/)
  if (match && method === 'GET') {
    let agent: string
    let name: string
    try {
      agent = decodeURIComponent(match[1])
      name = decodeURIComponent(match[2])
    } catch {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    if (!isSafeRelPath(name)) {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    if (!agents.includes(agent)) {
      json(res, { error: 'Unknown agent' }, 404)
      return true
    }
    const realRoot = realResearchRoot(agent)
    const file = realRoot ? resolveInside(realRoot, join(realRoot, name)) : null
    // Containment failure is reported as 404, not 403: whether the escaping
    // target exists is not something this endpoint should confirm.
    let isFile = false
    try {
      isFile = file !== null && statSync(file).isFile()
    } catch {
      isFile = false
    }
    if (!file || !isFile) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    const content = readFileSync(file, 'utf-8')
    json(res, { agent, name, title: titleOf(content, name), content })
    return true
  }

  return false
}
