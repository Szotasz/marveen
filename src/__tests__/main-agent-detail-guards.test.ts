import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const agentsSource = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')
const appSource = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) {
    throw new Error(`Cannot extract source between ${startMarker} and ${endMarker}`)
  }
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
    req: {} as RouteContext['req'],
    res,
    path: url.pathname,
    method,
    url,
  } as RouteContext
  return { ctx, out }
}

describe('main-agent detail and lifecycle guards', () => {
  it.each([
    [`/api/agents/${MAIN_AGENT_ID}/start`, 'POST'],
    [`/api/agents/${MAIN_AGENT_ID}/stop`, 'POST'],
    [`/api/agents/${MAIN_AGENT_ID}`, 'PUT'],
  ])('rejects %s before entering sub-agent logic', async (path, method) => {
    const { ctx, out } = fakeCtx(path, method)
    const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body?.error).toMatch(/Main agent/)
  })

  it('places lifecycle guards before sub-agent process and desired-state calls', () => {
    const startBlock = sourceBetween(agentsSource, 'const startMatch', 'const stopMatch')
    const stopBlock = sourceBetween(agentsSource, 'const stopMatch', '// Main-agent inbox PULL')

    expect(startBlock.indexOf('isMainChannelsAgent(name)')).toBeGreaterThan(-1)
    expect(startBlock.indexOf('isMainChannelsAgent(name)')).toBeLessThan(startBlock.indexOf('existsSync(agentDir(name))'))
    expect(startBlock.indexOf('isMainChannelsAgent(name)')).toBeLessThan(startBlock.indexOf('startAgentProcess(name'))

    expect(stopBlock.indexOf('isMainChannelsAgent(name)')).toBeGreaterThan(-1)
    expect(stopBlock.indexOf('isMainChannelsAgent(name)')).toBeLessThan(stopBlock.indexOf('stopAgentProcess(name)'))
    expect(stopBlock.indexOf('isMainChannelsAgent(name)')).toBeLessThan(stopBlock.indexOf('removeDesiredAgent(name)'))
  })

  it('routes the main id to openMarveenDetail before the generic detail fetch', () => {
    const detailBlock = sourceBetween(appSource, 'async function openAgentDetail(agentName)', 'function populateDetailAvatarGrid')
    const redirectIndex = detailBlock.indexOf('return openMarveenDetail()')
    const fetchIndex = detailBlock.indexOf('fetch(`/api/agents/')

    expect(redirectIndex).toBeGreaterThan(-1)
    expect(redirectIndex).toBeLessThan(fetchIndex)
    expect(detailBlock).toMatch(/if\s*\(agentName === mainAgentId\(\)\)/)
  })
})
