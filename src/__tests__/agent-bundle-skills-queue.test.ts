// The agent bundle export and import (single and whole-fleet) and the removal
// of an agent's directory all touch skill directories, so they wait on the
// skills directory queue. Each test holds the queue itself, starts the
// request, waits until the request has queued, checks that nothing ran yet,
// then releases and checks the outcome.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

const H = vi.hoisted(() => ({ queued: 0, inQueue: 0, running: false, dir: '', calls: [] as string[], kind: 'agent' as 'agent' | 'fleet' }))

// The counter tells a test when a request has queued, and inQueue whether a stand-in runs inside a queued operation.
vi.mock('../web/skills-dir-queue.js', async (orig) => {
  const real = await orig<typeof import('../web/skills-dir-queue.js')>()
  return { ...real, serializeSkillsDir: <T>(op: () => Promise<T> | T): Promise<T> => {
    H.queued++
    return real.serializeSkillsDir(async () => {
      H.inQueue++
      try { return await op() } finally { H.inQueue-- }
    })
  } }
})
vi.mock('../web/agent-bundle.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-bundle.js')>()),
  exportAgentBundle: (name: string, outPath: string) => { H.calls.push(`export ${name} q=${H.inQueue}`); writeFileSync(outPath, 'BUNDLE') },
  exportAllAgentsBundle: (outPath: string, names: string[]) => { H.calls.push(`export-all ${names.join(',')} q=${H.inQueue}`); writeFileSync(outPath, 'FLEET') },
  importAgentBundle: (_bundle: Buffer, opts: { overrideName?: string; overwrite?: boolean }) => { H.calls.push(`import ${String(opts.overrideName)} ${String(opts.overwrite)} q=${H.inQueue}`); return { name: 'zz-bundle-queue-probe', overwritten: false, manifest: { includesSecrets: false } } },
  importAllAgentsBundle: (_bundle: Buffer, opts: { overwrite?: boolean }) => { H.calls.push(`import-all ${String(opts.overwrite)} q=${H.inQueue}`); return { imported: [], skipped: [], includesSecrets: false } },
  peekBundleKind: () => H.kind,
}))
vi.mock('../web/agent-process.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => H.running,
  stopAgentProcess: async (name: string) => { H.calls.push(`stop ${name} dir=${existsSync(H.dir)} q=${H.inQueue}`); H.running = false; return { ok: true } },
}))
vi.mock('../web/agent-config.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['zz-bundle-queue-probe'] }))
vi.mock('../web/context-guard-store.js', async (orig) => ({ ...(await orig<typeof import('../web/context-guard-store.js')>()),
  seedContextGuardForNewAgent: () => {} }))

import { serializeSkillsDir } from '../web/skills-dir-queue.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import { PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { removeDesiredAgent } from '../web/agent-desired-state.js'
import type { RouteContext } from '../web/routes/types.js'

// A name no live fleet member can collide with; listAgentNames is mocked to it.
const T = 'zz-bundle-queue-probe'
H.dir = agentDir(T)

// Released again in afterEach: a test that fails before its release must not
// leave the queue held for the tests after it.
let releaseHeld: () => void = () => {}

function hold(): { release: () => void; held: Promise<void> } {
  let release: () => void = () => {}
  const held = serializeSkillsDir(() => new Promise<void>((resolve) => { release = resolve }))
  releaseHeld = () => release()
  return { release: () => release(), held }
}

async function waitForQueued(n: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (H.queued >= n) return
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${n} queued operations; ${H.queued} queued`)
}

function fakeCtx(path: string, method: string, body?: Buffer): {
  ctx: RouteContext
  out: { status: number; body: string }
} {
  const out = { status: 200, body: '' }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) out.body = typeof chunk === 'string' ? chunk : chunk.toString()
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req = Object.assign(Readable.from(body === undefined ? [] : [body]), { headers: { 'content-type': 'application/gzip' }, url: path })
  return {
    ctx: { req, res, path: url.pathname, method, url } as RouteContext,
    out,
  }
}

// Starts a request without awaiting it, keeping its promise and its response together.
function start(path: string, method: string, body?: Buffer): {
  p: Promise<boolean>
  out: { status: number; body: string }
} {
  const { ctx, out } = fakeCtx(path, method, body)
  return { p: tryHandleAgents(ctx, join(PROJECT_ROOT, 'web')), out }
}

afterEach(() => {
  releaseHeld()
  rmSync(agentDir(T), { recursive: true, force: true })
  removeDesiredAgent(T)
  H.calls.length = 0
  H.kind = 'agent'
  H.running = false
})

describe('agent bundle routes wait on the skills directory queue', () => {
  it('an agent export waits for the skills directory queue', async () => {
    mkdirSync(agentDir(T), { recursive: true })
    const { release, held } = hold()
    const before = H.queued
    const { ctx, out } = fakeCtx(`/api/agents/${T}/export`, 'GET')
    const p = tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    await waitForQueued(before + 1)
    expect(H.calls).toEqual([])
    release()
    await held
    expect(await p).toBe(true)
    expect(H.calls).toEqual([`export ${T} q=1`])
    expect(out.status).toBe(200)
    expect(out.body).toBe('BUNDLE')
  })

  it('a fleet bundle export waits for the skills directory queue', async () => {
    mkdirSync(agentDir(T), { recursive: true })
    const { release, held } = hold()
    const before = H.queued
    const { ctx, out } = fakeCtx('/api/agents/export-all', 'GET')
    const p = tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    await waitForQueued(before + 1)
    expect(H.calls).toEqual([])
    release()
    await held
    expect(await p).toBe(true)
    expect(H.calls).toEqual([`export-all ${T} q=1`])
    expect(out.status).toBe(200)
    expect(out.body).toBe('FLEET')
  })

  it('an agent import waits for the skills directory queue', async () => {
    const { release, held } = hold()
    const before = H.queued
    const { ctx, out } = fakeCtx('/api/agents/import', 'POST', Buffer.from('x'))
    const p = tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    await waitForQueued(before + 1)
    expect(H.calls).toEqual([])
    release()
    await held
    expect(await p).toBe(true)
    expect(H.calls).toEqual(['import undefined false q=1'])
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body).kind).toBe('agent')
  })

  it('a fleet bundle import waits for the skills directory queue', async () => {
    H.kind = 'fleet'
    const { release, held } = hold()
    const before = H.queued
    const { ctx, out } = fakeCtx('/api/agents/import?overwrite=1', 'POST', Buffer.from('x'))
    const p = tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    await waitForQueued(before + 1)
    expect(H.calls).toEqual([])
    release()
    await held
    expect(await p).toBe(true)
    expect(H.calls).toEqual(['import-all true q=1'])
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body).kind).toBe('fleet')
  })

  it('an agent delete removes the directory only after the queue frees', async () => {
    mkdirSync(agentDir(T), { recursive: true })
    const { release, held } = hold()
    const before = H.queued
    const { ctx, out } = fakeCtx(`/api/agents/${T}`, 'DELETE')
    const p = tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    await waitForQueued(before + 1)
    expect(existsSync(agentDir(T))).toBe(true)
    release()
    await held
    expect(await p).toBe(true)
    expect(existsSync(agentDir(T))).toBe(false)
    expect(JSON.parse(out.body).ok).toBe(true)
    expect(H.calls).toEqual([])
  })

  it('an agent export queued behind a delete of the same agent answers 404', async () => {
    mkdirSync(agentDir(T), { recursive: true })
    const { release, held } = hold()
    const before = H.queued
    const del = start(`/api/agents/${T}`, 'DELETE')
    await waitForQueued(before + 1)
    const exp = start(`/api/agents/${T}/export`, 'GET')
    await waitForQueued(before + 2)
    release()
    await held
    expect(await del.p).toBe(true)
    expect(await exp.p).toBe(true)
    expect(existsSync(agentDir(T))).toBe(false)
    expect(exp.out.status).toBe(404)
    expect(JSON.parse(exp.out.body).error).toBe('Agent not found')
    expect(H.calls).toEqual([])
  })

  it('a fleet bundle export queued behind a delete of its only agent answers 404', async () => {
    mkdirSync(agentDir(T), { recursive: true })
    const { release, held } = hold()
    const before = H.queued
    const del = start(`/api/agents/${T}`, 'DELETE')
    await waitForQueued(before + 1)
    const exp = start('/api/agents/export-all', 'GET')
    await waitForQueued(before + 2)
    release()
    await held
    expect(await del.p).toBe(true)
    expect(await exp.p).toBe(true)
    expect(existsSync(agentDir(T))).toBe(false)
    expect(exp.out.status).toBe(404)
    expect(JSON.parse(exp.out.body).error).toBe('No agents to export')
    expect(H.calls).toEqual([])
  })

  it('an agent started again while its delete waited is stopped before the removal', async () => {
    mkdirSync(agentDir(T), { recursive: true })
    const { release, held } = hold()
    const before = H.queued
    const { p, out } = start(`/api/agents/${T}`, 'DELETE')
    await waitForQueued(before + 1)
    H.running = true
    expect(H.calls).toEqual([])
    release()
    await held
    expect(await p).toBe(true)
    expect(H.calls).toEqual([`stop ${T} dir=true q=1`])
    expect(existsSync(agentDir(T))).toBe(false)
    expect(JSON.parse(out.body).ok).toBe(true)
  })
})
