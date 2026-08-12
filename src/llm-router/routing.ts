// Eco-mode local LLM router -- the routing decision, as code.
//
// The table below is docs/eco-mode-local-router-plan.md section 4, and every
// rule in it comes from the #133 measurements rather than from taste:
//
//   laguna    degenerates on /api/generate and needs `think: true` for
//             structured work -- so the router always uses /api/chat and sets
//             it, whatever the caller asked for.
//   gemma4    returns an EMPTY answer under ollama in its default thinking
//             mode -- so `think: false` is forced, and a caller cannot turn it
//             back on by accident.
//   StrikeX   evaluates long prompts at 52-570 tok/s: a 12k prompt costs one
//             to two minutes before a single token comes back. Anything above
//             the ceiling stays off that machine, even when it is the only one
//             left.
//
// These live HERE, in the router, and not in a prompt convention, because a
// convention is something the caller can forget. This module is pure: the
// health probe and the HTTP work sit next door, so the interesting decisions
// stay testable without a network.

export type HostName = 'air903max' | 'strikex'

export interface HostHealth {
  air903max: boolean
  strikex: boolean
}

export interface ChatMessage {
  role: string
  content: string
}

/** A concrete place to send the request, or the reason we are not sending it. */
export type RoutePlan =
  | {
      host: HostName
      /** Base URL candidates, in order: the first that answers health is used. */
      addresses: string[]
      model: string
      endpoint: '/api/chat'
      options: Record<string, unknown>
      refused?: undefined
    }
  | {
      refused: RefusalReason
      /** Said in words, because a refusal that only carries a code gets logged and ignored. */
      detail: string
      host?: undefined
    }

export type RefusalReason =
  | 'cloud-only'
  | 'no-healthy-host'
  | 'no-local-capacity'
  | 'prompt-too-long-for-fallback'
  | 'all-busy'

interface Target {
  host: HostName
  model: string
  /** Options the router forces on top of whatever the caller sent. */
  forced?: Record<string, unknown>
}

interface TaskClass {
  primary: Target | null
  fallback: Target | null
  /** Long-context work has no local fallback at all; see the plan. */
  cloudOnly?: boolean
}

const AIR_ADDRESSES = ['http://192.168.2.189:11434', 'http://192.168.2.163:11434']
const STRIKEX_ADDRESSES = ['http://192.168.2.31:11434']

/** Measured ceiling for StrikeX prompt evaluation; above this it goes elsewhere. */
export const STRIKEX_PROMPT_CEILING = 8_000

const QWEN_CODER: Target = { host: 'air903max', model: 'qwen3-coder:latest' }
const QWEN_SMALL: Target = { host: 'strikex', model: 'qwen3:14b' }

export const TASK_CLASSES: Record<string, TaskClass> = {
  // Structured extraction, labelling, digests -- measured with no capability
  // drop on the small machine, so it may fall back.
  structured: { primary: QWEN_CODER, fallback: QWEN_SMALL },
  summary: { primary: QWEN_CODER, fallback: QWEN_SMALL },
  general: { primary: QWEN_CODER, fallback: QWEN_SMALL },
  // Hungarian user-facing text stays in the gemma family on both legs. The
  // fallback used to be QWEN_SMALL, and on 2026-08-12 that turned a shipped
  // fix into a silent no-op: air903max stopped serving overnight, and the
  // morning brief was drafted by qwen3:14b -- the model the gemma route was
  // introduced to avoid. gemma4:12b is already on StrikeX (measured: 7.6 GB,
  // 50 tok/s, fully on GPU), so the degraded path is a smaller gemma rather
  // than a different model. `think: false` is repeated deliberately: it is a
  // property of gemma under ollama, not of the primary target, and without it
  // the fallback answers empty.
  hungarian: {
    primary: { host: 'air903max', model: 'gemma4:31b-magyar', forced: { think: false } },
    fallback: { host: 'strikex', model: 'gemma4:12b', forced: { think: false } },
  },
  code: {
    primary: { host: 'air903max', model: 'laguna-xs.2:fixed', forced: { think: true } },
    fallback: { host: 'strikex', model: 'qwen2.5-coder:14b' },
  },
  // 8-16k prompts: air903max or nothing. StrikeX would technically answer,
  // eventually, and "eventually" is the failure being avoided.
  'long-context': { primary: QWEN_CODER, fallback: null },
  // Not measured, and deliberately not attempted: routing an agent loop to a
  // local model would be a guess presented as a capability.
  'agent-loop': { primary: null, fallback: null, cloudOnly: true },
}

export const DEFAULT_TASK_CLASS = 'general'

/**
 * A deliberately conservative token estimate.
 *
 * There is no tokeniser here and there does not need to be one: the number
 * guards a ceiling, so erring high costs a fallback and erring low costs two
 * minutes of prompt evaluation. Three characters per token is below every
 * ratio measured on these models, which makes the estimate an upper bound in
 * practice.
 */
export function estimatePromptTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + (m?.content?.length ?? 0) + 8, 0)
  return Math.ceil(chars / 3)
}

const addressesFor = (host: HostName) => (host === 'air903max' ? AIR_ADDRESSES : STRIKEX_ADDRESSES)

function usable(
  target: Target,
  { health, busyHosts, promptTokens }: { health: HostHealth; busyHosts: Set<string>; promptTokens: number },
): { ok: true } | { ok: false; why: 'down' | 'busy' | 'prompt' } {
  if (!health[target.host]) return { ok: false, why: 'down' }
  if (target.host === 'strikex' && promptTokens > STRIKEX_PROMPT_CEILING) return { ok: false, why: 'prompt' }
  if (busyHosts.has(target.host)) return { ok: false, why: 'busy' }
  return { ok: true }
}

export interface RouteRequest {
  taskClass?: string
  promptTokens: number
  health: HostHealth
  /** One request per machine is the VRAM reality; this phase refuses rather than queues. */
  busyHosts: Set<string>
  callerOptions?: Record<string, unknown>
}

/**
 * Where this request goes, or why it goes nowhere.
 *
 * Refusal is a first-class answer here. Queueing would hide contention behind
 * latency, and falling back to a machine the measurements ruled out would hide
 * a two-minute wait behind a success -- both turn a capacity problem into a
 * mystery. The caller gets told, and decides (cloud, retry, later).
 */
export function planRoute(req: RouteRequest): RoutePlan {
  const className = req.taskClass && TASK_CLASSES[req.taskClass] ? req.taskClass : DEFAULT_TASK_CLASS
  const klass = TASK_CLASSES[className]

  if (klass.cloudOnly || !klass.primary) {
    return {
      refused: 'cloud-only',
      detail: `task class "${className}" is not measured for local models and stays in the cloud`,
    }
  }

  const candidates = [klass.primary, klass.fallback].filter(Boolean) as Target[]
  const verdicts = candidates.map((t) => ({ target: t, verdict: usable(t, req) }))
  const chosen = verdicts.find((v) => v.verdict.ok)

  if (chosen) {
    const target = chosen.target
    return {
      host: target.host,
      addresses: addressesFor(target.host),
      model: target.model,
      // Always chat: /api/generate was measured degenerating on laguna, and
      // one endpoint for every class keeps the passthrough honest.
      endpoint: '/api/chat',
      // Caller options first, forced rules last: the rules win, everything
      // else the caller sent survives.
      options: { ...(req.callerOptions ?? {}), ...(target.forced ?? {}) },
    }
  }

  // No target: say WHICH wall was hit, because the three have different fixes
  // (wake a machine, wait, or go to the cloud).
  const reasons = new Set(verdicts.map((v) => (v.verdict.ok ? 'ok' : v.verdict.why)))

  if (!klass.fallback && reasons.has('down')) {
    return {
      refused: 'no-local-capacity',
      detail: `"${className}" runs only on air903max, which is not answering`,
    }
  }
  if (reasons.has('prompt')) {
    return {
      refused: 'prompt-too-long-for-fallback',
      detail: `prompt is ${req.promptTokens} tokens; the fallback machine is limited to ${STRIKEX_PROMPT_CEILING}`,
    }
  }
  if (reasons.has('busy') && !reasons.has('down')) {
    return { refused: 'all-busy', detail: 'every eligible machine is serving another request' }
  }
  if (reasons.has('busy')) {
    return { refused: 'all-busy', detail: 'the machines that are up are already serving a request' }
  }
  return { refused: 'no-healthy-host', detail: 'no local machine is answering' }
}
