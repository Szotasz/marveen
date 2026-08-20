import { describe, it, expect } from 'vitest'
import { spansToOtelJson } from '../otel-exporter.js'
import type { OtelSpan } from '../db.js'

function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  return {
    trace_id: 'trace-001',
    span_id: 'span-001',
    parent_span_id: null,
    agent_id: 'agent-a',
    operation: 'test.op',
    start_ms: 1000,
    end_ms: 2000,
    status: 'ok',
    attributes: null,
    ...overrides,
  }
}

describe('spansToOtelJson', () => {
  it('returns resourceSpans array', () => {
    const result = spansToOtelJson([span()])
    expect(result).toHaveProperty('resourceSpans')
    expect(Array.isArray(result.resourceSpans)).toBe(true)
  })

  it('groups spans by agent_id into separate resourceSpans blocks', () => {
    const spans = [
      span({ agent_id: 'agent-a', span_id: 'span-a1' }),
      span({ agent_id: 'agent-b', span_id: 'span-b1' }),
      span({ agent_id: 'agent-a', span_id: 'span-a2' }),
    ]
    const result = spansToOtelJson(spans)
    expect(result.resourceSpans).toHaveLength(2)
    const agentABlock = result.resourceSpans.find(r =>
      r.resource.attributes.some(a => a.value.stringValue === 'marveen-agent-agent-a')
    )
    expect(agentABlock?.scopeSpans[0].spans).toHaveLength(2)
  })

  it('sets service.name to marveen-agent-<agent_id>', () => {
    const result = spansToOtelJson([span({ agent_id: 'agent-a' })])
    const attrs = result.resourceSpans[0].resource.attributes
    const serviceName = attrs.find(a => a.key === 'service.name')
    expect(serviceName?.value.stringValue).toBe('marveen-agent-agent-a')
  })

  it('converts start_ms and end_ms to nanoseconds strings', () => {
    const result = spansToOtelJson([span({ start_ms: 1000, end_ms: 2000 })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.startTimeUnixNano).toBe('1000000000')
    expect(s.endTimeUnixNano).toBe('2000000000')
  })

  it('falls back end_ms to start_ms for running spans', () => {
    const result = spansToOtelJson([span({ start_ms: 1500, end_ms: null, status: 'running' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.startTimeUnixNano).toBe('1500000000')
    expect(s.endTimeUnixNano).toBe('1500000000')
  })

  it('sets status code 1 (OK) for ok spans', () => {
    const result = spansToOtelJson([span({ status: 'ok' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(1)
  })

  it('sets status code 2 (ERROR) for error spans', () => {
    const result = spansToOtelJson([span({ status: 'error' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2)
  })

  it('sets status code 2 (ERROR) for timeout spans', () => {
    const result = spansToOtelJson([span({ status: 'timeout' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2)
  })

  it('sets status code 0 (UNSET) for running spans', () => {
    const result = spansToOtelJson([span({ status: 'running' })])
    expect(result.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(0)
  })

  it('omits parentSpanId when parent_span_id is null', () => {
    const result = spansToOtelJson([span({ parent_span_id: null })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s).not.toHaveProperty('parentSpanId')
  })

  it('includes parentSpanId when parent_span_id is set (normalised)', () => {
    const result = spansToOtelJson([span({ parent_span_id: 'parent-001' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.parentSpanId).toBe('parent001') // normaliseId strips hyphens
  })

  it('parses string attributes from JSON blob', () => {
    const result = spansToOtelJson([span({ attributes: JSON.stringify({ env: 'prod', count: 3 }) })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    const envAttr = s.attributes.find(a => a.key === 'env')
    expect(envAttr?.value.stringValue).toBe('prod')
    const countAttr = s.attributes.find(a => a.key === 'count')
    expect(countAttr?.value.intValue).toBe('3')
  })

  it('skips malformed attributes JSON without throwing', () => {
    const result = spansToOtelJson([span({ attributes: 'not-json{' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    // Should still have the built-in agent.id attribute
    expect(s.attributes.find(a => a.key === 'agent.id')).toBeDefined()
  })

  it('always includes agent.id and span.status built-in attributes', () => {
    const result = spansToOtelJson([span({ agent_id: 'agent-a', status: 'ok' })])
    const attrs = result.resourceSpans[0].scopeSpans[0].spans[0].attributes
    expect(attrs.find(a => a.key === 'agent.id')?.value.stringValue).toBe('agent-a')
    expect(attrs.find(a => a.key === 'span.status')?.value.stringValue).toBe('ok')
  })

  it('normalises hyphenated ids to lowercase hex', () => {
    const result = spansToOtelJson([span({ trace_id: 'TRACE-ABC', span_id: 'SPAN-DEF' })])
    const s = result.resourceSpans[0].scopeSpans[0].spans[0]
    expect(s.traceId).toBe('traceabc')
    expect(s.spanId).toBe('spandef')
  })

  it('returns empty resourceSpans for empty input', () => {
    const result = spansToOtelJson([])
    expect(result.resourceSpans).toHaveLength(0)
  })

  it('sets scope name to marveen', () => {
    const result = spansToOtelJson([span()])
    expect(result.resourceSpans[0].scopeSpans[0].scope.name).toBe('marveen')
  })
})
