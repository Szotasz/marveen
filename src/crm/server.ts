// CRM 1. utem (CRM1SKEL922): the HTTP skeleton. Same bearer token and the
// same check as the dashboard (store/.dashboard-token, checkBearerToken);
// /health is public; every /api/* path is gated; the static UI under
// web-crm/ is served from an explicit allowlist (no path traversal by
// construction). The lead endpoint and its gate landed with CRM1LEADKAPU922
// (Geri): the handlers live in leads-routes.ts, framework-independent, so
// this file only reads the request and hands over the parsed body.
import http from 'node:http'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { checkBearerToken } from '../web/dashboard-auth.js'
import { json, readBody, serveFile } from '../web/http-helpers.js'
import { CRM_TABLES } from './db.js'
import { createLead, todayLeads } from './leads-routes.js'
import { checkUncertain, performSend, queueSend, recordOutcome, requestResend } from './send-routes.js'
import { createSendProviderStub, type SendProvider } from './send-provider-stub.js'

export interface CrmServerOptions {
  token: string
  webDir: string
  crmDb: Database.Database
  /** The fleet store opened read-only, or null when it is not available. */
  readDb: Database.Database | null
  /**
   * The send provider. NO REAL SENDING IN THIS BUILD (CRM2SENDSTATE922): the default is the stub,
   * whose fixtures mirror what we MEASURED today, not what we wish were true. A real sender is a
   * separate, owner-approved step; until then every /api/send answer carries `stub: true` so the
   * caller cannot mistake a fixture for a delivery.
   */
  sendProvider?: SendProvider
}

const STATIC_ALLOWLIST: Record<string, string> = {
  '/app.js': 'app.js',
  '/style.css': 'style.css',
}

export const LEADS_ENDPOINT_CARD = 'CRM1LEADKAPU922'

export function createCrmServer(opts: CrmServerOptions): http.Server {
  const { token, webDir, crmDb, readDb } = opts
  const sendProvider = opts.sendProvider ?? createSendProviderStub()
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
      if (path === '/api/leads' && method === 'POST') {
        // A TORZS HORDOZZA A SZERZOT (spec 4. szakasz, dontes 2026-09-22). NEM fejlec: a torzs
        // kerul a nyomba. A szolgaltatas SOHA nem tolt szerzot konfigbol vagy konstansbol -- ha
        // az `actor` hianyzik, a kapu megtagadja, nem "system" nevben ment.
        // A torzs-hatar SZANDEKOSAN szuk (a 20 MB-os alapertelmezes egy lead-urlapnak ertelmetlen).
        readBody(req, { maxBytes: 64 * 1024 })
          .then((buf) => {
            let body: Record<string, unknown>
            try {
              body = buf.length ? (JSON.parse(buf.toString('utf-8')) as Record<string, unknown>) : {}
            } catch {
              json(res, { error: 'invalid JSON body' }, 400)
              return
            }
            const r = createLead(crmDb, body, typeof body.actor === 'string' ? body.actor : '')
            json(res, r.body, r.status)
          })
          .catch((err: Error) => {
            json(res, { error: err.name === 'RequestBodyTooLargeError' ? 'request body too large' : 'request failed' }, 413)
          })
        return
      }
      if (path.startsWith('/api/send')) {
        if (method !== 'POST') {
          json(res, { error: 'Method not allowed' }, 405)
          return
        }
        readBody(req, { maxBytes: 64 * 1024 })
          .then((buf) => {
            let body: Record<string, unknown>
            try {
              body = buf.length ? (JSON.parse(buf.toString('utf-8')) as Record<string, unknown>) : {}
            } catch {
              json(res, { error: 'invalid JSON body' }, 400)
              return
            }
            const actor = typeof body.actor === 'string' ? body.actor : ''
            const id = Number(body.attempt_id)
            let r: { status: number; body: Record<string, unknown> }
            if (path === '/api/send') r = performSend(crmDb, sendProvider, body, actor)
            else if (path === '/api/send/queue') r = queueSend(crmDb, body, actor)
            else if (path === '/api/send/outcome') r = recordOutcome(crmDb, id, actor, body.outcome as never)
            else if (path === '/api/send/check') r = checkUncertain(crmDb, id, actor, sendProvider)
            else if (path === '/api/send/resend') r = requestResend(crmDb, id, actor, body)
            else {
              json(res, { error: 'Not found' }, 404)
              return
            }
            // A VÁLASZ KIMONDJA, HOGY STUB. Egy "elküldve" felirat, ami mögött fixtúra áll, pont az
            // a hamis zöld, ami ellen ez az egész modul készült.
            json(res, { ...r.body, stub: sendProvider.isStub }, r.status)
          })
          .catch((err: Error) => {
            json(res, { error: err.name === 'RequestBodyTooLargeError' ? 'request body too large' : 'request failed' }, 413)
          })
        return
      }
      if (path === '/api/leads/today' && method === 'GET') {
        const r = todayLeads(crmDb)
        json(res, r.body, r.status)
        return
      }
      if (path === '/api/leads' || path.startsWith('/api/leads/')) {
        json(res, { error: `not in this build: this lead path is not implemented (${LEADS_ENDPOINT_CARD})` }, 404)
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
