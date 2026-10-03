import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
import { BUNDLE_SCHEMA_VERSION, importAgentBundle, importAllAgentsBundle } from '../web/agent-bundle.js'
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

describe('identity and lifecycle writes are refused for a protected agent', () => {
  const protectedName = DEFAULT_PROTECTED_AGENTS[0]

  // Sentinel's review (2026-10-03) on card 2fd5bfae: stopping a protected agent
  // is loud, rewriting it is silent. A missing supervisor is noticed; one whose
  // CLAUDE.md, mcp.json, model or auth was swapped still runs, still answers,
  // and is no longer the agent anyone relied on.
  it.each([
    [`/api/agents/${protectedName}`, 'config-overwrite'],
    [`/api/agents/${protectedName}/context-guard`, 'context-guard-write'],
    [`/api/agents/${protectedName}/remote`, 'remote-write'],
    [`/api/agents/${protectedName}/security`, 'security-profile-write'],
  ])('PUT %s returns 400 and names the action', async (path, action) => {
    const before = [...getDesiredAgents()].sort()
    const { ctx, out } = fakeCtx(path, 'PUT')
    const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))

    expect(handled).toBe(true)
    expect(out.status).toBe(400)
    expect(String(out.body?.error)).toContain(action)
    expect([...getDesiredAgents()].sort()).toEqual(before)
  })

  it('still serves GET /context-guard for a protected agent', async () => {
    // Reading the config is not a lifecycle change, and the dashboard needs it.
    // Refusing the read too would be protection theatre with a usability cost.
    const { ctx, out } = fakeCtx(`/api/agents/${protectedName}/context-guard`, 'GET')
    await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
    expect(out.status).not.toBe(400)
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

  it('every identity-write route refuses before it reads the body or writes', () => {
    // Same rule as stop/delete: the guard must precede the mutation, and here
    // also the readBody -- there is no reason to parse a payload we refuse.
    for (const [startMarker, endMarker, writeCall] of [
      ["const contextGuardMatch = path.match", "// GET /api/context-guard", 'writeContextGuardConfig(name'],
      ["const remoteCfgMatch = path.match", "if (path === '/api/team/graph'", 'writeAgentRemoteConfig(name'],
      ["if (secGetMatch && method === 'PUT')", '// PUT /api/agents/:name/auto-restart', 'writeAgentSecurityProfile(name'],
      ["if (agentMatch && method === 'PUT')", 'json(res, { ok: true })', 'checkAgentPutFields(name'],
    ] as const) {
      const block = sourceBetween(agentsSource, startMarker, endMarker)
      const guard = block.indexOf('denyProtectedWrite(name')
      expect(guard, `missing guard in ${startMarker}`).toBeGreaterThan(-1)
      expect(guard, `guard after write in ${startMarker}`).toBeLessThan(block.indexOf(writeCall))
      expect(guard, `guard after readBody in ${startMarker}`).toBeLessThan(block.indexOf('readBody(req)'))
    }
  })

  it('the reconciler names an out-of-band disappearance instead of logging a routine restart', () => {
    expect(monitorSource).toMatch(/Protected agent disappeared from tmux unexpectedly/)
    expect(monitorSource).toMatch(/protected agent disappeared from tmux unexpectedly, restarted/)
    const reconcile = sourceBetween(monitorSource, 'async function reconcileDesiredAgents', 'Backward-compatible alias')
    expect(reconcile.indexOf('isProtectedAgent(name)')).toBeGreaterThan(-1)
    expect(reconcile.indexOf('recordProtectedAgentEvent')).toBeGreaterThan(-1)
  })
})

describe('an overwriting import cannot replace a protected agent', () => {
  // The sharpest of the identity-rewrite doors: POST /api/agents/import with
  // overwrite=1 swaps the WHOLE agents/<name>/ directory in one call. The guard
  // sits in the importer rather than in the route, because the importer is where
  // the destination name is finally resolved (manifest name or ?name= override)
  // and where the rmSync happens -- a route-level check on the override alone
  // would miss a bundle that simply carries the protected name inside.
  const protectedName = DEFAULT_PROTECTED_AGENTS[0]
  let tmp: string

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'protected-import-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  function stage(root: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const p = join(root, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
    }
  }

  function packSingle(agentName: string, files: Record<string, string>): Buffer {
    const root = join(tmp, `single-${agentName}`)
    stage(join(root, 'agent'), files)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: BUNDLE_SCHEMA_VERSION, agentName, includesSecrets: false,
    }))
    const out = join(root, 'bundle.tar.gz')
    execFileSync('tar', ['-czf', out, '-C', root, 'manifest.json', 'agent'])
    return readFileSync(out)
  }

  function packFleet(agents: Record<string, Record<string, string>>): Buffer {
    const root = join(tmp, 'fleet')
    for (const [name, files] of Object.entries(agents)) stage(join(root, 'agents', name), files)
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      schemaVersion: BUNDLE_SCHEMA_VERSION, kind: 'fleet', agents: Object.keys(agents), includesSecrets: false,
    }))
    const out = join(root, 'fleet.tar.gz')
    execFileSync('tar', ['-czf', out, '-C', root, 'manifest.json', 'agents'])
    return readFileSync(out)
  }

  it('refuses the overwrite and leaves the installed persona byte-identical', () => {
    const dest = join(tmp, 'agents')
    stage(join(dest, protectedName), { 'CLAUDE.md': '# the real supervisor', '.mcp.json': '{"mcpServers":{}}' })
    const bundle = packSingle(protectedName, { 'CLAUDE.md': '# substituted', '.mcp.json': '{"mcpServers":{"evil":{}}}' })

    expect(() => importAgentBundle(bundle, { overwrite: true, resolveDest: (n) => join(dest, n) }))
      .toThrow(/Protected agent .* cannot be overwritten/)
    expect(readFileSync(join(dest, protectedName, 'CLAUDE.md'), 'utf8')).toBe('# the real supervisor')
    expect(readFileSync(join(dest, protectedName, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{}}')
  })

  it('refuses it just as firmly when the protected name comes from ?name=', () => {
    // The bundle is innocent-looking; the override is what aims it at the
    // supervisor. Resolving the guard after the override is what covers this.
    const dest = join(tmp, 'agents')
    stage(join(dest, protectedName), { 'CLAUDE.md': '# the real supervisor' })
    const bundle = packSingle('harmless', { 'CLAUDE.md': '# substituted' })

    expect(() => importAgentBundle(bundle, { overrideName: protectedName, overwrite: true, resolveDest: (n) => join(dest, n) }))
      .toThrow(/Protected agent .* cannot be overwritten/)
    expect(readFileSync(join(dest, protectedName, 'CLAUDE.md'), 'utf8')).toBe('# the real supervisor')
  })

  it('installs a protected name on a machine that does not have that agent yet', () => {
    // Deliberately allowed: there is no running supervisor to subvert here, and
    // refusing would block a legitimate move of the supervisor to a new host.
    const dest = join(tmp, 'agents')
    const bundle = packSingle(protectedName, { 'CLAUDE.md': '# fresh install' })
    const result = importAgentBundle(bundle, { resolveDest: (n) => join(dest, n) })

    expect(result.name).toBe(protectedName)
    expect(readFileSync(join(dest, protectedName, 'CLAUDE.md'), 'utf8')).toBe('# fresh install')
  })

  it('skips only the protected agent in a fleet import and still installs the rest', () => {
    const dest = join(tmp, 'agents')
    stage(join(dest, protectedName), { 'CLAUDE.md': '# the real supervisor' })
    stage(join(dest, 'alpha'), { 'CLAUDE.md': '# old alpha' })
    const bundle = packFleet({
      [protectedName]: { 'CLAUDE.md': '# substituted' },
      alpha: { 'CLAUDE.md': '# new alpha' },
    })

    const result = importAllAgentsBundle(bundle, { overwrite: true, resolveDest: (n) => join(dest, n) })

    expect(result.imported.map((a) => a.name)).toEqual(['alpha'])
    expect(result.skipped).toEqual([{ name: protectedName, reason: 'protected agent, not overwritten' }])
    expect(readFileSync(join(dest, protectedName, 'CLAUDE.md'), 'utf8')).toBe('# the real supervisor')
    expect(readFileSync(join(dest, 'alpha', 'CLAUDE.md'), 'utf8')).toBe('# new alpha')
  })

  it('the refusal sits before the directory is removed', () => {
    // Placement is load-bearing here too: a guard after the rmSync would leave
    // the supervisor deleted even though the import was refused.
    const source = readFileSync(join(__dirname, '..', 'web', 'agent-bundle.ts'), 'utf8')
    for (const marker of ['export function importAgentBundle', 'export function importAllAgentsBundle']) {
      const block = sourceBetween(source, marker, marker === 'export function importAgentBundle'
        ? 'Suggested download filename'
        : 'export function fleetBundleFilename')
      const guard = block.indexOf('isProtectedAgent(name)')
      expect(guard, `missing guard in ${marker}`).toBeGreaterThan(-1)
      expect(guard, `guard after rmSync in ${marker}`).toBeLessThan(block.indexOf('rmSync(dest'))
    }
  })
})
