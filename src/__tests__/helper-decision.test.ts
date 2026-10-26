// The helper's one model call (src/web/helper/decision.ts). Pinned from the
// Q1 measurement (SPEC.md): qwen3:14b answers thinking + text blocks, and a
// small max_tokens left the text EMPTY -- that must read as a failure, never
// as a decision.
import { describe, it, expect } from 'vitest'
import { parseDecision, responseText, buildDecisionRequest, callHelperDecision, HELPER_MIN_MAX_TOKENS } from '../web/helper/decision.js'
import type { CustomProviderDef } from '../web/custom-providers.js'

const def: CustomProviderDef = { id: 'o', label: 'O', baseUrl: 'http://127.0.0.1:11434/', authHeader: 'none', vaultKey: null, helperModel: 'qwen3:14b' }

function fakeFetch(status: number, body: unknown, seen?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (seen) { seen.url = url; seen.init = init }
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }) as unknown as typeof fetch
}

describe('parseDecision (strict contract)', () => {
  it('accepts the bare object and a json fence', () => {
    expect(parseDecision('{"action":"skip","reason":"nothing new"}')).toEqual({ action: 'skip', reason: 'nothing new' })
    expect(parseDecision('```json\n{"action":"escalate","reason":"released"}\n```')).toEqual({ action: 'escalate', reason: 'released' })
  })
  it.each([
    '',
    'Sure! {"action":"skip","reason":"x"}',
    '{"action":"ignore","reason":"x"}',
    '{"action":"skip"}',
    '{"action":"skip","reason":42}',
    '[{"action":"skip","reason":"x"}]',
    '{"action":"skip","reason":"x"',
  ])('rejects %j', (t) => expect(parseDecision(t)).toBeNull())
})

describe('responseText', () => {
  it('joins text blocks and ignores thinking', () => {
    expect(responseText({ content: [{ type: 'thinking', thinking: '{"action":"escalate","reason":"no"}' }, { type: 'text', text: '{"action":"skip",' }, { type: 'text', text: '"reason":"r"}' }] }))
      .toBe('{"action":"skip","reason":"r"}')
  })
})

describe('buildDecisionRequest', () => {
  it('never budgets below the measured floor and offers no tools', () => {
    const r = buildDecisionRequest('qwen3:14b', 'q', 'item', 200)
    expect(r.max_tokens).toBeGreaterThanOrEqual(1500)
    expect(HELPER_MIN_MAX_TOKENS).toBeGreaterThanOrEqual(1500)
    expect('tools' in r).toBe(false)
    expect(JSON.stringify(r.messages)).toContain('<<<ITEM')
  })
})

describe('callHelperDecision', () => {
  it('posts to <baseUrl>/v1/messages with the anthropic headers and returns the decision', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const r = await callHelperDecision(def, 'q', 'i', { fetch: fakeFetch(200, { content: [{ type: 'text', text: '{"action":"escalate","reason":"r"}' }] }, seen), getSecret: () => null })
    expect(r).toEqual({ ok: true, decision: { action: 'escalate', reason: 'r' } })
    expect(seen.url).toBe('http://127.0.0.1:11434/v1/messages')
    const h = seen.init!.headers as Record<string, string>
    expect(h['anthropic-version']).toBe('2023-06-01')
    expect(h['x-api-key']).toBe('none')
  })
  it('thinking-only (empty text) is invalid-json, not a skip', async () => {
    const r = await callHelperDecision(def, 'q', 'i', { fetch: fakeFetch(200, { content: [{ type: 'thinking', thinking: 'hmm' }] }), getSecret: () => null })
    expect(r).toMatchObject({ ok: false, error: 'invalid-json' })
  })
  it('HTTP error and missing model are failures', async () => {
    expect(await callHelperDecision(def, 'q', 'i', { fetch: fakeFetch(500, {}), getSecret: () => null })).toMatchObject({ ok: false, error: 'http' })
    expect(await callHelperDecision({ ...def, helperModel: undefined }, 'q', 'i', { fetch: fakeFetch(200, {}), getSecret: () => null })).toMatchObject({ ok: false, error: 'no-model' })
  })
  it('a hung endpoint times out', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })) as unknown as typeof fetch
    expect(await callHelperDecision(def, 'q', 'i', { fetch: hang, getSecret: () => null, timeoutMs: 20 })).toEqual({ ok: false, error: 'timeout' })
  })
  it('a Bearer provider sends the vault secret', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    await callHelperDecision({ ...def, authHeader: 'Bearer', vaultKey: 'k' }, 'q', 'i', { fetch: fakeFetch(200, { content: [] }, seen), getSecret: (id) => (id === 'k' ? 'sekret' : null) })
    expect((seen.init!.headers as Record<string, string>).authorization).toBe('Bearer sekret')
  })
})

describe('capability boundary (SPEC.md 7)', () => {
  it('the decision module has no runtime imports at all: no send, email, kanban or channel path exists in it', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(fileURLToPath(new URL('../web/helper/decision.ts', import.meta.url)), 'utf-8')
    const imports = src.split('\n').filter((l) => /^import\s/.test(l))
    expect(imports.every((l) => /^import type\s/.test(l))).toBe(true)
  })
})
