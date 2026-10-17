// Character nicknames for the kanban board.
//
// An optional character name per team member, shown next to the plain name on
// the kanban lanes, on the cards and on the Team page. It belongs with the
// portraits: the nickname is what the picture is a picture OF.
//
// Deployment-local, like the model-profile map: store/ is gitignored, so a
// fleet's own names never leave the machine, and config-examples/ documents the
// shape. A MISSING file is fine and means no nicknames: every lane still
// renders with its name, which is what the board did before this existed.
//
// Keyed by the assignee name as the kanban knows it (the owner's full name, the
// bot name, or an agent id), matched case-insensitively so "Alice" and "alice"
// are the same person.
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { PROJECT_ROOT } from '../config.js'

const NICKNAMES_PATH = join(PROJECT_ROOT, 'store', 'team-nicknames.json')

let cached: { map: Map<string, string>; mtimeMs: number } | null = null

function load(): Map<string, string> {
  const empty = new Map<string, string>()
  try {
    if (!existsSync(NICKNAMES_PATH)) return empty
    const mtimeMs = statSync(NICKNAMES_PATH).mtimeMs
    if (cached && cached.mtimeMs === mtimeMs) return cached.map
    const raw = JSON.parse(readFileSync(NICKNAMES_PATH, 'utf-8'))
    const src = (raw && typeof raw === 'object' && raw.nicknames && typeof raw.nicknames === 'object')
      ? raw.nicknames
      : raw
    const map = new Map<string, string>()
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (typeof k !== 'string' || typeof v !== 'string') continue
        const name = k.trim()
        const nick = v.trim()
        if (!name || !nick) continue
        map.set(name.toLowerCase(), nick)
      }
    }
    cached = { map, mtimeMs }
    return map
  } catch {
    // A malformed file must not take the board down: no nicknames is a valid
    // state, a 500 on /api/kanban/assignees is not.
    return empty
  }
}

export function nicknameFor(name: string): string | undefined {
  if (!name) return undefined
  return load().get(String(name).trim().toLowerCase())
}
