import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import {
  DEFAULT_PROTECTED_AGENTS,
  describeApiCaller,
  getProtectedAgents,
  isProtectedAgent,
  recordProtectedAgentEvent,
} from '../web/protected-agents.js'
import { getDesiredAgents } from '../web/agent-desired-state.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentsSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')
const monitorSource = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf8')

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) throw new Error(`Cannot extract source between ${startMarker} and ${endMarker}`)
  return source.slice(start, end)
}

function fakeCtx(path: string, method: string): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> | null }
} {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown>
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req: { socket: { remoteAddress: '127.0.0.1' } } as RouteContext['req'],
    res,
    path: url.pathname,
    method,
    url,
    auth: { kind: 'token' as const },
  } as RouteContext
  return { ctx, out }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'protected-agents-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('protected-agents list', () => {
  it('reads the agents named in the file', () => {
    const file = join(dir, 'protected-agents.json')
    writeFileSync(file, JSON.stringify(['sentinel', 'aegon']))
    expect([...getProtectedAgents(file)].sort()).toEqual(['aegon', 'sentinel'])
    expect(isProtectedAgent('sentinel', file)).toBe(true)
    expect(isProtectedAgent('atlas', file)).toBe(false)
  })

  it.each([
    ['missing', null],
    ['not valid JSON', '{nope'],
    ['not an array', '{"sentinel":true}'],
  ])('falls back to the built-in list when the file is %s', (_label, content) => {
    const file = join(dir, 'protected-agents.json')
    if (content !== null) writeFileSync(file, content)
    // The fallback is what makes "just delete the file" a non-bypass: an
    // absent or broken list must never mean "nothing is protected".
    expect([...getProtectedAgents(file)]).toEqual([...DEFAULT_PROTECTED_AGENTS])
    expect(isProtectedAgent('sentinel', file)).toBe(true)
  })

  it('honours a valid list that drops a built-in default (operator decision)', () => {
    const file = join(dir, 'protected-agents.json')
    writeFileSync(file, JSON.stringify(['aegon']))
    expect(isProtectedAgent('sentinel', file)).toBe(false)
  })

  it('ignores non-string and blank entries', () => {
    const file = join(dir, 'protected-agents.json')
    writeFileSync(file, JSON.stringify(['sentinel', 42, null, '  ', ' aegon ']))
    expect([...getProtectedAgents(file)].sort()).toEqual(['aegon', 'sentinel'])
  })

  it('exports no writer -- the API may read this list, never edit it', async () => {
    const mod = await import('../web/protected-agents.js')
    const writerish = Object.keys(mod).filter((k) => /^(set|write|add|remove|update|delete)/i.test(k))
    expect(writerish).toEqual([])
  })
})

describe('protected-agent audit trail', () => {
  it('appends one JSON line per event', () => {
    const log = join(dir, 'protected-agent-block.log')
    recordProtectedAgentEvent({ agent: 'sentinel', action: 'stop', outcome: 'blocked', source: 'token@127.0.0.1' }, log)
    recordProtectedAgentEvent({ agent: 'sentinel', action: 'delete', outcome: 'blocked' }, log)
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ agent: 'sentinel', action: 'stop', outcome: 'blocked', source: 'token@127.0.0.1' })
    expect(lines[1]).toMatchObject({ action: 'delete' })
    expect(Date.parse(lines[0].at as string)).not.toBeNaN()
  })

  it('never throws when the log cannot be written', () => {
    // Runs inside request handling: a full disk must not turn a refused stop
    // into a 500 the caller can retry until something gives.
    const unwritable = join(dir, 'no-such-dir', 'block.log')
    expect(() => recordProtectedAgentEvent({ agent: 'sentinel', action: 'stop', outcome: 'blocked' }, unwritable)).not.toThrow()
  })

  it('describes the caller without claiming it identifies a human', () => {
    expect(describeApiCaller({ kind: 'token' }, '10.0.0.5')).toBe('token@10.0.0.5')
    expect(describeApiCaller({ kind: 'session', user: 'peter' })).toBe('session:peter')
    expect(describeApiCaller(undefined)).toBe('unauthenticated')
  })
})

describe('stop and delete routes refuse a protected agent', () => {
  const protectedName = DEFAULT_PROTECTED_AGENTS[0]

  it.each([
    [`/api/agents/${protectedName}/stop`, 'POST', /nem állítható le/],
    [`/api/agents/${protectedName}`, 'DELETE', /nem törölhető/],
  ])('%s %s returns 400 and leaves the desired list untouched', async (path, method, message) => {
    const before = [...getDesiredAgents()].sort()
    const { ctx, out } = fakeCtx(path, method)
    const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(String(out.body?.error)).toMatch(message)
    // The sharpest failure mode this guard exists to prevent: a refusal that
    // still cleared the intent would leave the agent unprotected at the next
    // reconcile, while the operator was told the call was rejected.
    expect([...getDesiredAgents()].sort()).toEqual(before)
  })
})

describe('guard placement is load-bearing', () => {
  it('stop checks protection before clearing desired state or stopping', () => {
    const stopBlock = sourceBetween(agentsSource, 'const stopMatch', '// Main-agent inbox PULL')
    const guard = stopBlock.indexOf('isProtectedAgent(name)')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(stopBlock.indexOf('removeDesiredAgent(name)'))
    expect(guard).toBeLessThan(stopBlock.indexOf('stopAgentProcess(name)'))
  })

  it('delete checks protection before the dir check, the desired clear and the rmSync', () => {
    const deleteBlock = sourceBetween(agentsSource, "if (agentMatch && method === 'DELETE')", '// GET /api/agents/:name/voice-config')
    const guard = deleteBlock.indexOf('isProtectedAgent(name)')
    expect(guard).toBeGreaterThan(-1)
    // Before existsSync: protection must not depend on the directory being
    // there, which is the accident the main agent relied on until now.
    expect(guard).toBeLessThan(deleteBlock.indexOf('existsSync(dir)'))
    expect(guard).toBeLessThan(deleteBlock.indexOf('removeDesiredAgent(name)'))
    expect(guard).toBeLessThan(deleteBlock.indexOf('rmSync(dir'))
    // The main agent gets an explicit guard here too, instead of 404-ing by
    // structural coincidence.
    expect(deleteBlock.indexOf('isMainChannelsAgent(name)')).toBeGreaterThan(-1)
  })

  it('the reconciler names an out-of-band disappearance instead of logging a routine restart', () => {
    expect(monitorSource).toMatch(/Protected agent disappeared from tmux unexpectedly/)
    expect(monitorSource).toMatch(/protected agent disappeared from tmux unexpectedly, restarted/)
    const reconcile = sourceBetween(monitorSource, 'async function reconcileDesiredAgents', 'Backward-compatible alias')
    expect(reconcile.indexOf('isProtectedAgent(name)')).toBeGreaterThan(-1)
    expect(reconcile.indexOf('recordProtectedAgentEvent')).toBeGreaterThan(-1)
  })
})
