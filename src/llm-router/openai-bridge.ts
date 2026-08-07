// Translation between what callers speak and what the machines speak.
//
// Callers -- agents, scheduled prompts, OpenWebUI -- speak OpenAI. The two GPU
// hosts speak ollama. Keeping the translation here, pure and tested, is not
// ceremony: a field dropped in translation is not an error anywhere, it is a
// silently different request. The `think` flag is the example that matters --
// lose it and gemma returns an empty string, which looks like a bad model
// rather than a bad call.

import type { RefusalReason, RoutePlan } from './routing.js'

type Plan = Extract<RoutePlan, { host: string }>

export interface OpenAiChatRequest {
  model?: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  max_tokens?: number
  task_class?: string
}

/**
 * The ollama /api/chat body for a planned route.
 *
 * The model is the ROUTER's, never the caller's: the caller names a task
 * class, and honouring a model name from outside would let anyone step around
 * the measured rules. `think` is lifted out of options because ollama takes it
 * at the top level.
 */
export function toOllamaChat(req: OpenAiChatRequest, plan: Plan): Record<string, unknown> {
  const { think, ...rest } = plan.options ?? {}
  const options: Record<string, unknown> = { ...rest }
  if (typeof req.temperature === 'number' && options.temperature === undefined) {
    options.temperature = req.temperature
  }
  if (typeof req.max_tokens === 'number') options.num_predict = req.max_tokens

  return {
    model: plan.model,
    messages: req.messages ?? [],
    // Single response. Streaming belongs to a later phase; a half-built stream
    // that quietly returns the first chunk is worse than no stream at all.
    stream: false,
    ...(think === undefined ? {} : { think }),
    ...(Object.keys(options).length ? { options } : {}),
  }
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string }
  prompt_eval_count?: number
  eval_count?: number
  done_reason?: string
}

/**
 * The OpenAI-shaped answer.
 *
 * `model` and `x_router_host` report what ACTUALLY served the request, not
 * what was asked for -- a report that echoes the request cannot be used to
 * check what the router did, which is the one thing the acceptance test needs.
 * Missing counts stay null rather than becoming zero: an invented zero is a
 * measurement nobody took.
 */
export function toOpenAiResponse(
  ollama: OllamaChatResponse,
  served: { model: string; host: string },
): Record<string, any> {
  const prompt = typeof ollama.prompt_eval_count === 'number' ? ollama.prompt_eval_count : null
  const completion = typeof ollama.eval_count === 'number' ? ollama.eval_count : null

  return {
    object: 'chat.completion',
    model: served.model,
    x_router_host: served.host,
    choices: [
      {
        index: 0,
        message: { role: ollama.message?.role ?? 'assistant', content: ollama.message?.content ?? '' },
        finish_reason: ollama.done_reason ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt !== null && completion !== null ? prompt + completion : null,
    },
  }
}

const REFUSAL_STATUS: Record<RefusalReason, number> = {
  // Come back: the caller can retry or go to the cloud. A 500 would say only
  // that something here is broken, which is not what happened.
  'all-busy': 503,
  'no-healthy-host': 503,
  'no-local-capacity': 503,
  // The request is too big for the machine that is left -- a fact about the
  // payload, not a fault.
  'prompt-too-long-for-fallback': 413,
  // Not implemented, by decision. Neither side is broken.
  'cloud-only': 501,
}

/** The refusal body shape, declared rather than implied: callers assert on its words. */
export interface RefusalBody {
  error: { code: RefusalReason; message: string; type: 'router_refusal' }
}

export function refusalToHttp(
  reason: RefusalReason,
  detail: string,
): { status: number; headers: Record<string, string>; body: RefusalBody } {
  const status = REFUSAL_STATUS[reason] ?? 503
  return {
    status,
    headers: status === 503 ? { 'Retry-After': '15' } : {},
    // The reason travels in words as well as in a code: a refusal that carries
    // only a code gets logged and ignored.
    body: { error: { code: reason, message: detail, type: 'router_refusal' } },
  }
}

/**
 * The task class the caller asked for, if any.
 *
 * Header first: a proxy sets it deliberately, while a body field can be
 * whatever a client library copied. Neither present returns undefined rather
 * than a default -- planRoute owns the default, and a decision in two places
 * is a decision that will drift.
 */
export function taskClassOf(
  headers: Record<string, string | string[] | undefined>,
  body: { task_class?: string },
): string | undefined {
  const header = headers['x-task-class']
  const fromHeader = Array.isArray(header) ? header[0] : header
  return fromHeader || body?.task_class || undefined
}
