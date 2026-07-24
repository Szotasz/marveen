import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentConfigRoot, listAgentNames } from '../agent-config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Read-only viewer for each agent's research/ folder (agents/<name>/research/,
// or the project root for the main agent). Mirrors routes/docs.ts: everything
// sits under /api/* (bearer-token gated), nothing is writable, and filenames
// are allowlisted + basename-checked to block path traversal.
const NAME_RE = /^[A-Za-z0-9._-]+\.md$/

function titleOf(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

function researchDir(agent: string): string {
  return join(agentConfigRoot(agent), 'research')
}

export async function tryHandleResearch(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/research' && method === 'GET') {
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    const result = agents.map(agent => {
      const dir = researchDir(agent)
      let files: string[] = []
      try {
        files = readdirSync(dir).filter(
          f => NAME_RE.test(f) && statSync(join(dir, f)).isFile(),
        )
      } catch {
        files = []
      }
      const docs = files
        .map(name => {
          let title = name
          let ms = 0
          try {
            const file = join(dir, name)
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

  const match = path.match(/^\/api\/research\/([^/]+)\/([^/]+)$/)
  if (match && method === 'GET') {
    const agent = decodeURIComponent(match[1])
    const name = decodeURIComponent(match[2])
    if (!NAME_RE.test(name) || basename(name) !== name) {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    if (!agents.includes(agent)) {
      json(res, { error: 'Unknown agent' }, 404)
      return true
    }
    const file = join(researchDir(agent), name)
    if (!existsSync(file) || !statSync(file).isFile()) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    const content = readFileSync(file, 'utf-8')
    json(res, { agent, name, title: titleOf(content, name), content })
    return true
  }

  return false
}
