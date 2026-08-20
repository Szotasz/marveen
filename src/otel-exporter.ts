// Thin OTEL JSON exporter: maps otel_spans rows to the OTLP/JSON wire format
// (resourceSpans -> scopeSpans -> spans). Targets the Protobuf-JSON encoding
// used by Grafana Tempo, Jaeger, and any OTLP-HTTP collector.
//
// Spec: opentelemetry-proto/trace/v1/trace.proto (JSON encoding)

import type { OtelSpan } from './db.js'

interface OtelAttribute {
  key: string
  value: { stringValue?: string; intValue?: string; boolValue?: boolean }
}

interface OtelSpanExport {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  status: { code: number; message?: string }
  attributes: OtelAttribute[]
}

interface ScopeSpans {
  scope: { name: string; version: string }
  spans: OtelSpanExport[]
}

interface ResourceSpans {
  resource: { attributes: OtelAttribute[] }
  scopeSpans: ScopeSpans[]
}

export interface OtelExportPayload {
  resourceSpans: ResourceSpans[]
}

// OTLP status codes: 0=UNSET, 1=OK, 2=ERROR
function statusCode(status: OtelSpan['status']): number {
  if (status === 'ok') return 1
  if (status === 'error' || status === 'timeout') return 2
  return 0 // running / unknown
}

// Parse the JSON attributes blob stored in the DB into OTEL attribute list.
// The blob is expected to be a flat Record<string, string | number | boolean>.
function parseAttributes(raw: string | null): OtelAttribute[] {
  if (!raw) return []
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(obj).map(([key, val]) => {
      if (typeof val === 'boolean') return { key, value: { boolValue: val } }
      if (typeof val === 'number') return { key, value: { intValue: String(Math.round(val)) } }
      return { key, value: { stringValue: String(val) } }
    })
  } catch {
    return []
  }
}

// ms -> nanosecond string (OTEL uses string to avoid JS integer overflow)
function msToNano(ms: number): string {
  return String(ms * 1_000_000)
}

// Normalise a hex trace/span id to the OTEL canonical form (lowercase hex).
// If the id is not already hex (e.g. a UUID-like string), pass it through.
function normaliseId(id: string): string {
  return id.replace(/-/g, '').toLowerCase()
}

// Group spans by agent_id, then emit one resourceSpans block per agent
// so Grafana Tempo / Jaeger can filter by service.name.
export function spansToOtelJson(spans: OtelSpan[]): OtelExportPayload {
  const byAgent = new Map<string, OtelSpan[]>()
  for (const span of spans) {
    const bucket = byAgent.get(span.agent_id) ?? []
    bucket.push(span)
    byAgent.set(span.agent_id, bucket)
  }

  const resourceSpans: ResourceSpans[] = []
  for (const [agentId, agentSpans] of byAgent) {
    const exportedSpans: OtelSpanExport[] = agentSpans.map((s) => {
      const endMs = s.end_ms ?? s.start_ms // fallback for still-running spans
      const out: OtelSpanExport = {
        traceId: normaliseId(s.trace_id),
        spanId: normaliseId(s.span_id),
        name: s.operation,
        startTimeUnixNano: msToNano(s.start_ms),
        endTimeUnixNano: msToNano(endMs),
        status: { code: statusCode(s.status) },
        attributes: [
          { key: 'agent.id', value: { stringValue: s.agent_id } },
          { key: 'span.status', value: { stringValue: s.status } },
          ...parseAttributes(s.attributes),
        ],
      }
      if (s.parent_span_id) out.parentSpanId = normaliseId(s.parent_span_id)
      return out
    })

    resourceSpans.push({
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: `marveen-agent-${agentId}` } },
          { key: 'service.namespace', value: { stringValue: 'marveen' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'marveen', version: '1' },
        spans: exportedSpans,
      }],
    })
  }

  return { resourceSpans }
}
