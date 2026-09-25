import { listPrLedger } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// PRLEDGER907 -- read-only window query over the fleet PR ledger, so any later
// surface (a slide, a dashboard tab) pulls FRESH data instead of a snapshot
// baked into HTML. Bearer-gated like every /api/* route; strictly GET, the
// table is written only by scripts/pr-ledger-collect.mjs.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export async function tryHandlePrLedger(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/pr-ledger' && method === 'GET') {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    const repo = url.searchParams.get('repo') ?? undefined
    if (!DAY_RE.test(from) || !DAY_RE.test(to)) {
      json(res, { error: 'from and to are required as YYYY-MM-DD' }, 400)
      return true
    }
    if (to < from) {
      json(res, { error: 'to must not precede from' }, 400)
      return true
    }
    const { rows, summary } = listPrLedger(from, to, repo)
    json(res, { from, to, repo: repo ?? null, summary, rows })
    return true
  }

  return false
}
