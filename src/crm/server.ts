// CRM 1. utem (CRM1SKEL922): the HTTP skeleton. Same bearer token and the
// same check as the dashboard (store/.dashboard-token, checkBearerToken);
// /health is public; every /api/* path is gated; the static UI under
// web-crm/ is served from an explicit allowlist (no path traversal by
// construction). POST /api/leads is NOT here: that endpoint and its gate are
// CRM1LEADKAPU922 (Geri); until it lands the path answers 404 with the card id.
import http from 'node:http'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { checkBearerToken } from '../web/dashboard-auth.js'
import { json, serveFile } from '../web/http-helpers.js'
import { CRM_TABLES } from './db.js'

export interface CrmServerOptions {
  token: string
  webDir: string
  crmDb: Database.Database
  /** The fleet store opened read-only, or null when it is not available. */
  readDb: Database.Database | null
}

const STATIC_ALLOWLIST: Record<string, string> = {
  '/app.js': 'app.js',
  '/style.css': 'style.css',
}

export const LEADS_ENDPOINT_CARD = 'CRM1LEADKAPU922'

export function createCrmServer(opts: CrmServerOptions): http.Server {
  const { token, webDir, crmDb, readDb } = opts
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    if (path === '/health') {
      json(res, { ok: true, service: 'crm', crmDb: true, claudeclawReadOnly: readDb !== null })
      return
    }

    if (path.startsWith('/api/')) {
      if (!checkBearerToken(req.headers.authorization, token)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        json(res, { error: 'Unauthorized' }, 401)
        return
      }
      if (path === '/api/leads' || path.startsWith('/api/leads/')) {
        json(res, { error: `not in this build: the lead endpoint and its gate are ${LEADS_ENDPOINT_CARD}` }, 404)
        return
      }
      if (path === '/api/status' && method === 'GET') {
        const tables: Record<string, number> = {}
        for (const t of CRM_TABLES) {
          tables[t] = (crmDb.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
        }
        let claudeclaw: { readonly: true; kanbanCards: number } | null = null
        if (readDb) {
          try {
            const n = (readDb.prepare(`SELECT count(*) AS n FROM kanban_cards WHERE archived_at IS NULL`).get() as { n: number }).n
            claudeclaw = { readonly: true, kanbanCards: n }
          } catch {
            claudeclaw = null
          }
        }
        json(res, { ok: true, service: 'crm', tables, claudeclaw })
        return
      }
      json(res, { error: 'Not found' }, 404)
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      json(res, { error: 'Method not allowed' }, 405)
      return
    }
    if (path === '/' || path === '/index.html') {
      serveFile(req, res, join(webDir, 'index.html'), { cacheSeconds: 0 })
      return
    }
    const file = STATIC_ALLOWLIST[path]
    if (file) {
      serveFile(req, res, join(webDir, file), { cacheSeconds: 0 })
      return
    }
    json(res, { error: 'Not found' }, 404)
  })
}
