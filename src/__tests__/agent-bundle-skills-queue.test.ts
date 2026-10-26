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

const H = vi.hoisted(() => ({ queued: 0, calls: [] as string[], kind: 'agent' as 'agent' | 'fleet' }))

vi.mock('../web/skills-dir-queue.js', async (orig) => {
  const real = await orig<typeof import('../web/skills-dir-queue.js')>()
  return { serializeSkillsDir: <T>(op: () => Promise<T> | T): Promise<T> => { H.queued++; return real.serializeSkillsDir(op) } }
})
vi.mock('../web/agent-bundle.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-bundle.js')>()),
  exportAgentBundle: (name: string, outPath: string) => { H.calls.push(`export ${name}`); writeFileSync(outPath, 'BUNDLE') },
  exportAllAgentsBundle: (outPath: string) => { H.calls.push('export-all'); writeFileSync(outPath, 'FLEET') },
  importAgentBundle: () => { H.calls.push('import'); return { name: 'zz-bundle-queue-probe', overwritten: false, manifest: { includesSecrets: false } } },
  importAllAgentsBundle: () => { H.calls.push('import-all'); return { imported: [], skipped: [], includesSecrets: false } },
  peekBundleKind: () => H.kind,
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

afterEach(() => {
  releaseHeld()
  rmSync(agentDir(T), { recursive: true, force: true })
  removeDesiredAgent(T)
  H.calls.length = 0
  H.kind = 'agent'
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
    expect(H.calls).toEqual([`export ${T}`])
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
    expect(H.calls).toEqual(['export-all'])
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
    expect(H.calls).toEqual(['import'])
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body).kind).toBe('agent')
  })

  it('a fleet bundle import waits for the skills directory queue', async () => {
    H.kind = 'fleet'
    const { release, held } = hold()
    const before = H.queued
    const { ctx, out } = fakeCtx('/api/agents/import', 'POST', Buffer.from('x'))
    const p = tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    await waitForQueued(before + 1)
    expect(H.calls).toEqual([])
    release()
    await held
    expect(await p).toBe(true)
    expect(H.calls).toEqual(['import-all'])
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
  })
})
