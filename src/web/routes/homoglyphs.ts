import { getDb } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

/**
 * Read side of the homoglyph journal (GATEHOMOGLIFSWEEP816). The triggers on
 * kanban_cards/kanban_comments journal suspicious inserts (writes that bypass
 * the API); this endpoint surfaces them for the periodic sweep. Marking a
 * finding resolved records that someone READ the word and either fixed it by
 * hand or classified it as legitimate content -- the row itself never says
 * which, the fix lives where the text lives.
 */
export async function tryHandleHomoglyphs(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/homoglyphs' && method === 'GET') {
    const includeResolved = url.searchParams.get('all') === '1'
    const rows = getDb()
      .prepare(
        `SELECT id, src_table, src_id, sample, found_at, resolved_at
         FROM homoglyph_findings
         ${includeResolved ? '' : 'WHERE resolved_at IS NULL'}
         ORDER BY id DESC LIMIT 200`
      )
      .all()
    json(res, { findings: rows })
    return true
  }

  const resolveMatch = path.match(/^\/api\/homoglyphs\/(\d+)\/resolve$/)
  if (resolveMatch && method === 'POST') {
    const info = getDb()
      .prepare('UPDATE homoglyph_findings SET resolved_at = unixepoch() WHERE id = ? AND resolved_at IS NULL')
      .run(Number(resolveMatch[1]))
    json(res, { ok: true, changed: info.changes })
    return true
  }

  return false
}
