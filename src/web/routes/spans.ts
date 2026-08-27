import { upsertOtelSpan, closeOtelSpan, getOtelTrace, listOtelTraces, queryOtelSpans } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { spansToOtelJson } from '../../otel-exporter.js'
import type { RouteContext } from './types.js'

export async function tryHandleSpans(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/spans -- open or close a span
  // Open: { trace_id, span_id, parent_span_id?, agent_id, operation, start_ms, attributes? }
  // Close (patch): { trace_id, span_id, end_ms, status? }
  if (path === '/api/spans' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      trace_id: string
      span_id: string
      parent_span_id?: string | null
      agent_id?: string
      operation?: string
      start_ms?: number
      end_ms?: number
      status?: 'ok' | 'error' | 'timeout' | 'running'
      attributes?: string
    }
    if (!data.trace_id || !data.span_id) {
      json(res, { error: 'required', hint: 'trace_id and span_id required' }, 400)
      return true
    }
    if (data.end_ms !== undefined) {
      // Close path: update end_ms + status
      const ok = closeOtelSpan(data.trace_id, data.span_id, data.end_ms, data.status ?? 'ok')
      if (!ok) {
        // Span may not exist yet -- treat as upsert-close (agent sent single event)
        if (!data.agent_id || !data.operation || data.start_ms === undefined) {
          json(res, { error: 'not_found', hint: 'span not found; provide agent_id, operation, start_ms to create and close in one call' }, 404)
          return true
        }
        upsertOtelSpan({
          trace_id: data.trace_id, span_id: data.span_id,
          parent_span_id: data.parent_span_id ?? null,
          agent_id: data.agent_id, operation: data.operation,
          start_ms: data.start_ms, end_ms: data.end_ms,
          status: data.status ?? 'ok',
          attributes: data.attributes ?? null,
        })
      }
    } else {
      // Open path: must have agent_id, operation, start_ms
      if (!data.agent_id || !data.operation || data.start_ms === undefined) {
        json(res, { error: 'required', hint: 'agent_id, operation, and start_ms required to open a span' }, 400)
        return true
      }
      upsertOtelSpan({
        trace_id: data.trace_id, span_id: data.span_id,
        parent_span_id: data.parent_span_id ?? null,
        agent_id: data.agent_id, operation: data.operation,
        start_ms: data.start_ms, end_ms: null,
        status: 'running',
        attributes: data.attributes ?? null,
      })
    }
    json(res, { ok: true })
    return true
  }

  // GET /api/traces -- list recent traces
  if (path === '/api/traces' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)
    json(res, listOtelTraces(limit))
    return true
  }

  // GET /api/traces/:id -- full span tree for a trace
  const traceMatch = path.match(/^\/api\/traces\/([^/]+)$/)
  if (traceMatch && method === 'GET') {
    const traceId = traceMatch[1]
    const spans = getOtelTrace(traceId)
    if (!spans.length) { json(res, { error: 'not_found', hint: 'trace not found' }, 404); return true }
    json(res, { trace_id: traceId, spans })
    return true
  }

  // GET /api/otel-export -- OTLP/JSON export of otel_spans rows
  // Query params: agent (agent_id filter), from (unix ms), to (unix ms), limit (max 5000)
  if (path === '/api/otel-export' && method === 'GET') {
    const agentParam = url.searchParams.get('agent') ?? undefined
    const fromParam = url.searchParams.get('from')
    const toParam = url.searchParams.get('to')
    const limitParam = url.searchParams.get('limit')
    const fromMs = fromParam ? parseInt(fromParam) : undefined
    const toMs = toParam ? parseInt(toParam) : undefined
    const limit = limitParam ? Math.min(parseInt(limitParam), 5000) : 1000
    if ((fromMs !== undefined && isNaN(fromMs)) || (toMs !== undefined && isNaN(toMs))) {
      json(res, { error: 'invalid_value', hint: 'from and to must be unix timestamps in milliseconds' }, 400)
      return true
    }
    const spans = queryOtelSpans({ agent: agentParam, fromMs, toMs, limit })
    const payload = spansToOtelJson(spans)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
    return true
  }

  return false
}
