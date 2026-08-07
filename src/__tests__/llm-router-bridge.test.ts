import { describe, it, expect } from 'vitest'
import { toOllamaChat, toOpenAiResponse, refusalToHttp, taskClassOf } from '../llm-router/openai-bridge.js'

// The translation between what callers speak (OpenAI) and what the machines
// speak (ollama).
//
// It is a small surface with one large risk: a field dropped here is not an
// error anywhere, it is a silently different request. The stop sequence that
// makes laguna usable, the think flag that makes gemma answer at all -- both
// are options, and options are exactly what a sloppy translation loses.

describe('turning an OpenAI request into an ollama one', () => {
  const plan = {
    host: 'air903max' as const,
    addresses: ['http://192.168.2.189:11434'],
    model: 'laguna-xs.2:fixed',
    endpoint: '/api/chat' as const,
    options: { think: true, temperature: 0.2 },
  }

  it('carries the messages through unchanged', () => {
    const body = toOllamaChat({ model: 'ignored-by-us', messages: [{ role: 'user', content: 'hi' }] }, plan)
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('uses the model the ROUTER chose, not the one the caller named', () => {
    // The caller asks for a task class; the model is ours to pick. Honouring
    // a caller's model name would let anyone bypass the measured rules.
    const body = toOllamaChat({ model: 'gpt-4o', messages: [] }, plan)
    expect(body.model).toBe('laguna-xs.2:fixed')
  })

  it('keeps the forced options, which is the whole point of the router', () => {
    const body = toOllamaChat({ model: 'x', messages: [] }, plan)
    expect(body.think).toBe(true)
    expect(body.options).toMatchObject({ temperature: 0.2 })
  })

  it('asks for a single response, not a stream', () => {
    // Streaming is a later phase; a half-implemented stream that silently
    // returns the first chunk would be worse than none.
    expect(toOllamaChat({ model: 'x', messages: [] }, plan).stream).toBe(false)
  })
})

describe('turning the ollama answer back into an OpenAI one', () => {
  const ollama = {
    message: { role: 'assistant', content: 'the answer' },
    prompt_eval_count: 120,
    eval_count: 40,
    done_reason: 'stop',
  }

  it('puts the text where an OpenAI client looks for it', () => {
    const out = toOpenAiResponse(ollama, { model: 'qwen3-coder:latest', host: 'air903max' })
    expect(out.choices[0].message).toMatchObject({ role: 'assistant', content: 'the answer' })
    expect(out.choices[0].finish_reason).toBe('stop')
  })

  it('reports the model that actually answered', () => {
    // Not the model the caller asked for: a report that echoes the request
    // cannot be used to check what the router did.
    const out = toOpenAiResponse(ollama, { model: 'qwen3-coder:latest', host: 'air903max' })
    expect(out.model).toBe('qwen3-coder:latest')
  })

  it('carries the token counts, because the cost story needs them', () => {
    const out = toOpenAiResponse(ollama, { model: 'm', host: 'air903max' })
    expect(out.usage).toMatchObject({ prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 })
  })

  it('says which machine served it, in a field a client can ignore', () => {
    expect(toOpenAiResponse(ollama, { model: 'm', host: 'strikex' }).x_router_host).toBe('strikex')
  })

  it('does not invent counts the machine did not report', () => {
    const out = toOpenAiResponse({ message: { role: 'assistant', content: 'x' } }, { model: 'm', host: 'air903max' })
    expect(out.usage.prompt_tokens).toBe(null)
    expect(out.usage.completion_tokens).toBe(null)
  })
})

describe('what a refusal looks like on the wire', () => {
  it('answers a busy fleet with 503 and a Retry-After, not a 500', () => {
    // The caller can act on "come back": retry, or go to the cloud. A 500
    // tells them only that something is broken here.
    const { status, headers } = refusalToHttp('all-busy', 'every eligible machine is serving another request')
    expect(status).toBe(503)
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0)
  })

  it('answers a cloud-only class with 501, which is not a failure', () => {
    // We are not broken and the caller is not wrong: this router does not do
    // that kind of work, by decision.
    expect(refusalToHttp('cloud-only', 'x').status).toBe(501)
  })

  it('answers an oversized prompt with 413, naming the ceiling', () => {
    const { status, body } = refusalToHttp('prompt-too-long-for-fallback', 'prompt is 9000 tokens; limit 8000')
    expect(status).toBe(413)
    expect(body.error.message).toMatch(/8000/)
  })

  it('always carries the reason in words, never only a code', () => {
    for (const reason of ['all-busy', 'no-healthy-host', 'no-local-capacity'] as const) {
      const { body } = refusalToHttp(reason, 'measured detail')
      expect(body.error.message).toContain('measured detail')
      expect(body.error.code).toBe(reason)
    }
  })
})

describe('finding the task class the caller asked for', () => {
  it('reads the header', () => {
    expect(taskClassOf({ 'x-task-class': 'code' }, {})).toBe('code')
  })

  it('reads the body field when there is no header', () => {
    expect(taskClassOf({}, { task_class: 'hungarian' })).toBe('hungarian')
  })

  it('prefers the header, because a proxy sets it deliberately', () => {
    expect(taskClassOf({ 'x-task-class': 'code' }, { task_class: 'hungarian' })).toBe('code')
  })

  it('returns undefined rather than guessing when neither is present', () => {
    // planRoute applies the default; guessing here would put the same decision
    // in two places.
    expect(taskClassOf({}, {})).toBeUndefined()
  })
})
