// The eco-mode local LLM router.
//
// One small service in front of the two GPU hosts, so that agents, scheduled
// prompts and OpenWebUI can all reach the local models without knowing which
// machine is awake or which flags a given model needs. Phase P1 of
// docs/eco-mode-local-router-plan.md: static table, health gate, OpenAI
// endpoint, and NO queue.
//
// No queue is a decision, not a shortcut. One request per machine is the VRAM
// reality; waiting would hide contention behind latency, and the caller can
// always do something better with a refusal (retry, cloud, later) than with a
// request that silently takes two minutes.
//
// There is no authentication here, by design and by constraint: ollama has
// none either, so the whole thing stays LAN-only and nothing is published
// outward. Binding is explicit for that reason.

import http from 'node:http'
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { planRoute, estimatePromptTokens, TASK_CLASSES, type HostHealth, type HostName } from './routing.js'
import { createHealthCache } from './health.js'
import { toOllamaChat, toOpenAiResponse, refusalToHttp, taskClassOf, type OpenAiChatRequest } from './openai-bridge.js'
import { servedMetric, refusedMetric, summarise, toJsonl, parseJsonl, type RouteMetric } from './metrics.js'

const HOST_ADDRESSES: Record<HostName, string[]> = {
  air903max: ['http://192.168.2.189:11434', 'http://192.168.2.163:11434'],
  strikex: ['http://192.168.2.31:11434'],
}

export interface RouterDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  /**
   * Where the per-request records go. One JSON object per line, appended.
   *
   * A record is written with a single appendFileSync call: on Linux an append
   * of this size lands whole, so two requests finishing together interleave as
   * complete lines rather than as halves of one. The reader skips a damaged
   * final line anyway, so a crash mid-write costs the record being written and
   * nothing above it.
   */
  metricsPath?: string
  /** Recording failures must never fail a request; this exists so a test can see them. */
  onMetricError?: (err: Error) => void
}

/**
 * The request handler, separated from the socket so it can be driven by tests
 * without binding a port.
 */
export function createRouterHandler(deps: RouterDeps = {}) {
  const fetchImpl = (deps.fetchImpl ?? fetch) as typeof fetch
  const health = createHealthCache({ fetchImpl: fetchImpl as any, now: deps.now })

  // One in-flight request per machine. A Set, not a counter: the question is
  // "is this machine busy", and a counter invites a limit that the VRAM does
  // not actually have.
  const busyHosts = new Set<string>()

  const metricsPath = deps.metricsPath ?? process.env.ROUTER_METRICS_PATH ?? null
  const clock = deps.now ?? (() => Date.now())

  /**
   * Write one record.
   *
   * Swallows its own errors on purpose: a full disk or a bad path must cost the
   * measurement, never the answer a caller is waiting for. The error goes to a
   * hook so a test can prove it happened rather than trusting the silence.
   */
  const record = (metric: RouteMetric) => {
    if (!metricsPath) return
    try {
      const dir = dirname(metricsPath)
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(metricsPath, toJsonl(metric))
    } catch (err) {
      deps.onMetricError?.(err as Error)
    }
  }

  const readRecords = (): RouteMetric[] => {
    if (!metricsPath || !existsSync(metricsPath)) return []
    try {
      return parseJsonl(readFileSync(metricsPath, 'utf8'))
    } catch {
      return []
    }
  }

  async function currentHealth(): Promise<HostHealth> {
    const [air, strike] = await Promise.all([
      health.get('air903max', HOST_ADDRESSES.air903max),
      health.get('strikex', HOST_ADDRESSES.strikex),
    ])
    return { air903max: air.up, strikex: strike.up }
  }

  async function addressFor(host: HostName): Promise<string | null> {
    const probe = await health.get(host, HOST_ADDRESSES[host])
    return probe.address
  }

  async function handleChat(body: OpenAiChatRequest, headers: http.IncomingHttpHeaders) {
    const startedAt = clock()
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const requestedClass = taskClassOf(headers as Record<string, string | string[] | undefined>, body)
    // Recorded as ASKED FOR, so an unknown label appears in the numbers as
    // itself instead of as the default it silently became.
    const metricClass = requestedClass ?? '(default)'
    const plan = planRoute({
      taskClass: requestedClass,
      promptTokens: estimatePromptTokens(messages),
      health: await currentHealth(),
      busyHosts,
    })

    if (plan.refused) {
      const answer = refusalToHttp(plan.refused, plan.detail)
      record(refusedMetric({
        at: startedAt,
        taskClass: metricClass,
        status: answer.status,
        refusal: plan.refused,
        totalMs: clock() - startedAt,
      }))
      return answer
    }

    const address = await addressFor(plan.host)
    if (!address) {
      // The health cache said up and the address vanished between the two --
      // rare, and still not a reason to invent a target.
      const answer = refusalToHttp('no-healthy-host', `${plan.host} stopped answering between the health check and the call`)
      record(refusedMetric({
        at: startedAt,
        taskClass: metricClass,
        status: answer.status,
        refusal: 'no-healthy-host',
        totalMs: clock() - startedAt,
        host: plan.host,
      }))
      return answer
    }

    busyHosts.add(plan.host)
    try {
      const res = await fetchImpl(`${address}${plan.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toOllamaChat(body, plan)),
      })
      if (!res.ok) {
        record(refusedMetric({
          at: startedAt, taskClass: metricClass, status: 502,
          refusal: 'upstream_error', totalMs: clock() - startedAt, host: plan.host,
        }))
        return {
          status: 502,
          headers: {},
          body: { error: { code: 'upstream_error', message: `${plan.host} answered HTTP ${res.status}`, type: 'router_upstream' } },
        }
      }
      const json = (await res.json()) as any
      record(servedMetric({
        at: startedAt, taskClass: metricClass, host: plan.host, model: plan.model,
        totalMs: clock() - startedAt, ollama: json,
      }))
      return { status: 200, headers: {}, body: toOpenAiResponse(json, { model: plan.model, host: plan.host }) }
    } catch (err) {
      record(refusedMetric({
        at: startedAt, taskClass: metricClass, status: 502,
        refusal: 'upstream_unreachable', totalMs: clock() - startedAt, host: plan.host,
      }))
      return {
        status: 502,
        headers: {},
        body: { error: { code: 'upstream_unreachable', message: `${plan.host}: ${(err as Error).message}`, type: 'router_upstream' } },
      }
    } finally {
      // Released whatever happened: a slot leaked on an error path would take
      // a machine out of service until restart, silently.
      busyHosts.delete(plan.host)
    }
  }

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://router.local')
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const now = await currentHealth()
      return send(200, {
        hosts: health.peek(),
        up: now,
        busy: [...busyHosts],
        classes: Object.keys(TASK_CLASSES),
      })
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      // Aggregated from the FILE rather than from a counter in memory: a
      // restart must not quietly reset the numbers an acceptance check is
      // comparing against.
      const records = readRecords()
      return send(200, { ...summarise(records), path: metricsPath, since: records[0]?.at ?? null })
    }

    // Both the OpenAI path and the native one land in the same place: the
    // routing rules must not depend on which door a caller used.
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/api/chat')) {
      let body: OpenAiChatRequest
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return send(400, { error: { code: 'invalid_json', message: 'request body is not JSON', type: 'router_request' } })
      }
      const result = await handleChat(body, req.headers)
      return send(result.status, result.body, result.headers)
    }

    return send(404, { error: { code: 'not_found', message: `no route for ${req.method} ${url.pathname}`, type: 'router_request' } })
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data || '{}'))
    req.on('error', reject)
  })
}

export function startRouter({ port = 11500, bindAddress = '0.0.0.0', deps = {} as RouterDeps } = {}) {
  const server = http.createServer(createRouterHandler(deps))
  server.listen(port, bindAddress)
  return server
}
