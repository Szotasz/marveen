import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Read-only viewer for the project's docs/ folder. Both endpoints sit under
// /api/* so the dashboard's bearer-token gate already protects them -- no extra
// auth wiring here. Nothing is writable; this only ever reads .md files that
// already live in the repo.
const DOCS_DIR = join(PROJECT_ROOT, 'docs')
// Allowlist: a bare markdown filename. Combined with the basename() check below
// this blocks path traversal (../, absolute paths, nested segments).
const NAME_RE = /^[A-Za-z0-9._-]+\.md$/

function titleOf(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

export async function tryHandleDocs(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/docs' && method === 'GET') {
    let files: string[] = []
    try {
      files = readdirSync(DOCS_DIR).filter(
        f => NAME_RE.test(f) && statSync(join(DOCS_DIR, f)).isFile(),
      )
    } catch {
      files = []
    }
    const docs = files.sort().map(name => {
      let title = name
      let created: string | null = null
      try {
        const file = join(DOCS_DIR, name)
        title = titleOf(readFileSync(file, 'utf-8'), name)
        const s = statSync(file)
        // birthtime is the file's creation time; on filesystems that don't track
        // it (returns 0) fall back to the last-modified time.
        const ms = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs
        created = new Date(ms).toISOString().slice(0, 10)
      } catch {
        /* keep filename as title, created stays null */
      }
      return { name, title, created }
    })
    json(res, docs)
    return true
  }

  const match = path.match(/^\/api\/docs\/([^/]+)$/)
  if (match && method === 'GET') {
    const name = decodeURIComponent(match[1])
    if (!NAME_RE.test(name) || basename(name) !== name) {
      json(res, { error: 'Invalid doc name' }, 400)
      return true
    }
    const file = join(DOCS_DIR, name)
    if (!existsSync(file) || !statSync(file).isFile()) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    const content = readFileSync(file, 'utf-8')
    json(res, { name, title: titleOf(content, name), content })
    return true
  }

  return false
}
