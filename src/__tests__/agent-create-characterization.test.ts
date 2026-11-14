// Characterization of POST /api/agents as it stands BEFORE the base of the handler is lifted out
// (MIOAGENTINSTALL1114, PR-I0). Behaviour only, through the route: the eight refusals (status, body
// and ORDER), and the synchronous writes that follow them (which, with what, in which order).
//
// Why behaviour and not source text: the next commit moves the refusals and the writes into
// src/web/agent-create.ts. A test that reads the handler's source would have to move with it and
// would prove nothing about the move. These tests replace the handler's collaborators at their
// modules, so they hold for the handler wherever its body lives.
//
// Nothing is created by this file: every write is a recorder, the agent directory is redirected to
// a temp folder, and the step after the base writes (the personality snapshot) throws a marker, so
// "the request got past the base writes" is observable and the LLM step is never reached.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, ...unknown[]]>,
  agentsRoot: '',
  cliVersion: null as string | null,
  knownProviders: new Set<string>(),
  installDefault: 'claude-sonnet-5',
}))
h.agentsRoot = mkdtempSync(join(tmpdir(), 'agent-create-char-'))
afterAll(() => { rmSync(h.agentsRoot, { recursive: true, force: true }) })

const record = (fn: string) => (...args: unknown[]) => { h.calls.push([fn, ...args]) }

vi.mock('../web/agent-scaffold.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-scaffold.js')>()),
  scaffoldAgentDir: record('scaffoldAgentDir'),
  writeAgentSettingsFromProfile: record('writeAgentSettingsFromProfile'),
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  agentDir: (name: string) => join(h.agentsRoot, name),
  writeAgentModel: record('writeAgentModel'),
  writeAgentCustomProvider: record('writeAgentCustomProvider'),
  writeAgentSecurityProfile: record('writeAgentSecurityProfile'),
  writeAgentDisplayName: record('writeAgentDisplayName'),
}))
vi.mock('../web/context-guard-store.js', async (orig) => ({
  ...(await orig<typeof import('../web/context-guard-store.js')>()),
  seedContextGuardForNewAgent: record('seedContextGuardForNewAgent'),
}))
vi.mock('../web/profiles.js', async (orig) => ({
  ...(await orig<typeof import('../web/profiles.js')>()),
  loadProfileTemplate: (id: string) => ({ loadedProfile: id }),
}))
vi.mock('../web/custom-providers.js', async (orig) => ({
  ...(await orig<typeof import('../web/custom-providers.js')>()),
  loadCustomProvider: (id: string) => (h.knownProviders.has(id) ? { id } : null),
}))
vi.mock('../web/default-model-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/default-model-guard.js')>()),
  launchableInstallDefault: async (...args: unknown[]) => { h.calls.push(['launchableInstallDefault', ...args]); return h.installDefault },
}))
// The CLI gate measures the installed CLI; here the measurement is a variable, no process is spawned.
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: async (...args: unknown[]) => { h.calls.push(['measureClaudeCliVersion', ...args]); return { version: h.cliVersion } },
}))
// The first step AFTER the base writes: stop there.
vi.mock('../web/persona-write-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/persona-write-guard.js')>()),
  snapshotPersonaFile: (): never => { throw new Error('PAST_BASE_WRITES') },
}))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { PROJECT_ROOT, MAIN_AGENT_ID, RESERVED_AGENT_IDS } = await import('../config.js')
const { InvalidModelIdError } = await import('../model-id.js')

const WRITES = ['scaffoldAgentDir', 'writeAgentModel', 'writeAgentCustomProvider', 'writeAgentSecurityProfile',
  'writeAgentSettingsFromProfile', 'seedContextGuardForNewAgent', 'writeAgentDisplayName']
// A model the gate refuses on CLI 2.1.110 and a version at which it does (picker-cli-gate.test.ts measures both).
const GATED_MODEL = 'claude-opus-5-5'
const OLD_CLI = '2.1.110'
const BAD_MODEL = 'bad model id!'

type Out = { status: number; body: any; pastBaseWrites: boolean; writes: Array<[string, ...unknown[]]>; calls: Array<[string, ...unknown[]]> }
async function post(data: Record<string, unknown>): Promise<Out> {
  h.calls.length = 0
  const req = Readable.from([Buffer.from(JSON.stringify(data))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out = { status: 0, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL('http://127.0.0.1:3420/api/agents')
  let pastBaseWrites = false
  try {
    await tryHandleAgents({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))
  } catch (err) {
    if ((err as Error)?.message !== 'PAST_BASE_WRITES') throw err
    pastBaseWrites = true
  }
  const calls = h.calls.map((c) => [...c] as [string, ...unknown[]])
  return { status: out.status, body: out.body, pastBaseWrites, writes: calls.filter((c) => WRITES.includes(c[0])), calls }
}
const existing = (name: string) => { mkdirSync(join(h.agentsRoot, name), { recursive: true }); return name }

beforeEach(() => {
  h.cliVersion = null            // unmeasured: the gate refuses nothing (fail-open)
  h.knownProviders = new Set(['known-prov'])
  h.installDefault = 'claude-sonnet-5'
})

describe('POST /api/agents: positive control', () => {
  it('a valid request passes every refusal and gets past the base writes', async () => {
    const r = await post({ name: 'char-ok', description: 'x', model: 'claude-sonnet-5' })
    expect(r.pastBaseWrites).toBe(true)
    expect(r.status).toBe(0)
    expect(r.writes.map((c) => c[0])[0]).toBe('scaffoldAgentDir')
    expect(existsSync(join(h.agentsRoot, 'char-ok'))).toBe(false)
  })
})

describe('POST /api/agents: the eight refusals, each alone (status and body), and nothing is written', () => {
  const refused = (r: Out, status: number, body: unknown) => {
    expect([r.status, r.body]).toEqual([status, body])
    expect(r.pastBaseWrites).toBe(false)
    expect(r.writes).toEqual([])
  }

  it('1. no name: 400', async () => {
    refused(await post({ name: '   ', description: 'x', model: 'claude-sonnet-5' }), 400, { error: 'Name is required' })
    refused(await post({ description: 'x', model: 'claude-sonnet-5' }), 400, { error: 'Name is required' })
    refused(await post({ name: 42, description: 'x', model: 'claude-sonnet-5' }), 400, { error: 'Name is required' })
  })

  it('2. malformed model id: 400 with the model-id error text', async () => {
    const r = await post({ name: 'char-a', description: 'x', model: BAD_MODEL })
    refused(r, 400, { error: new InvalidModelIdError(BAD_MODEL).message })
    expect(r.body.error).toContain(JSON.stringify(BAD_MODEL))
  })

  it('3. unknown custom provider: 400 naming it', async () => {
    refused(await post({ name: 'char-a', description: 'x', model: 'claude-sonnet-5', customProvider: 'nope' }), 400, { error: 'Unknown custom provider: nope' })
  })

  it('4. a model the measured CLI cannot launch: 422 with the gate body', async () => {
    h.cliVersion = OLD_CLI
    const r = await post({ name: 'char-a', description: 'x', model: GATED_MODEL })
    expect(r.status).toBe(422)
    expect(r.body).toMatchObject({ error: 'model not launchable by the installed Claude Code CLI', model: GATED_MODEL, installedCli: OLD_CLI })
    expect(Object.keys(r.body).sort()).toEqual(['error', 'installedCli', 'message', 'minCli', 'model'])
    expect(r.pastBaseWrites).toBe(false)
    expect(r.writes).toEqual([])
    // the probe is fresh
    expect(r.calls.filter((c) => c[0] === 'measureClaudeCliVersion')).toEqual([['measureClaudeCliVersion', { fresh: true }]])
  })

  it('5. no description: 400', async () => {
    refused(await post({ name: 'char-a', model: 'claude-sonnet-5' }), 400, { error: 'Description is required' })
    refused(await post({ name: 'char-a', description: '', model: 'claude-sonnet-5' }), 400, { error: 'Description is required' })
  })

  it('6. the main agent id: 409', async () => {
    refused(await post({ name: MAIN_AGENT_ID, description: 'x', model: 'claude-sonnet-5' }), 409, { error: 'Name is reserved for the main agent' })
  })

  it('7. a reserved id: 409', async () => {
    for (const name of ['system', 'status']) {
      expect(RESERVED_AGENT_IDS).toContain(name)
      refused(await post({ name, description: 'x', model: 'claude-sonnet-5' }), 409, { error: 'Name is reserved by the system' })
    }
  })

  it('8. the agent directory exists: 409', async () => {
    refused(await post({ name: existing('char-exists'), description: 'x', model: 'claude-sonnet-5' }), 409, { error: 'Agent already exists' })
  })
})

describe('POST /api/agents: the ORDER of the refusals', () => {
  // A chain: each request breaks every rule from its own step onward that one request can break, and the
  // answer must be the refusal of that step. (An invalid model id and a CLI-gated model are one field, so
  // step 2 cannot also break rule 4; the main agent id is not in the reserved list, so step 6 cannot also
  // break rule 7. Those two neighbours are pinned by the pairs below, as far as a request can express them.)
  it('name, then model, then provider, then the CLI gate, then description, then main id, then reserved, then exists', async () => {
    expect(RESERVED_AGENT_IDS).not.toContain(MAIN_AGENT_ID)
    existing(MAIN_AGENT_ID); existing('status'); existing('char-chain')
    h.cliVersion = OLD_CLI
    const answers: Array<[number, unknown]> = []
    const step = async (data: Record<string, unknown>) => { const r = await post(data); expect(r.writes).toEqual([]); answers.push([r.status, r.body?.error]) }
    await step({ name: '', model: BAD_MODEL, customProvider: 'nope' })
    await step({ name: MAIN_AGENT_ID, model: BAD_MODEL, customProvider: 'nope' })
    await step({ name: MAIN_AGENT_ID, model: GATED_MODEL, customProvider: 'nope' })
    await step({ name: MAIN_AGENT_ID, model: GATED_MODEL, customProvider: 'known-prov' })
    h.cliVersion = null
    await step({ name: MAIN_AGENT_ID, model: GATED_MODEL, customProvider: 'known-prov' })
    await step({ name: MAIN_AGENT_ID, model: GATED_MODEL, customProvider: 'known-prov', description: 'x' })
    await step({ name: 'status', model: GATED_MODEL, customProvider: 'known-prov', description: 'x' })
    await step({ name: 'char-chain', model: GATED_MODEL, customProvider: 'known-prov', description: 'x' })
    expect(answers).toEqual([
      [400, 'Name is required'],
      [400, new InvalidModelIdError(BAD_MODEL).message],
      [400, 'Unknown custom provider: nope'],
      [422, 'model not launchable by the installed Claude Code CLI'],
      [400, 'Description is required'],
      [409, 'Name is reserved for the main agent'],
      [409, 'Name is reserved by the system'],
      [409, 'Agent already exists'],
    ])
  })

  it('the CLI gate answers before the description check, and is not probed when an earlier check refuses', async () => {
    h.cliVersion = OLD_CLI
    const gated = await post({ name: 'char-a', model: GATED_MODEL })
    expect(gated.status).toBe(422)
    for (const data of [{ name: '', model: GATED_MODEL }, { name: 'char-a', model: BAD_MODEL }, { name: 'char-a', model: GATED_MODEL, customProvider: 'nope' }]) {
      const r = await post(data)
      expect(r.status).toBe(400)
      expect(r.calls.filter((c) => c[0] === 'measureClaudeCliVersion')).toEqual([])
    }
  })

  it('a reserved id that also exists as a directory is "reserved", an ordinary one is "exists"', async () => {
    expect((await post({ name: existing('system'), description: 'x', model: 'claude-sonnet-5' })).body).toEqual({ error: 'Name is reserved by the system' })
    expect((await post({ name: existing('char-plain'), description: 'x', model: 'claude-sonnet-5' })).body).toEqual({ error: 'Agent already exists' })
  })
})

describe('POST /api/agents: the model the checks and the writes see', () => {
  it('no model in the request: the guarded install default is asked for (fresh), BEFORE the name check, and is what gets written', async () => {
    h.installDefault = 'claude-haiku-4-5-20251001'
    const noName = await post({ name: '', description: 'x' })
    expect(noName.status).toBe(400)
    expect(noName.calls).toEqual([['launchableInstallDefault', 'agent-create', { fresh: true }]])
    const ok = await post({ name: 'char-default', description: 'x' })
    expect(ok.pastBaseWrites).toBe(true)
    expect(ok.writes.find((c) => c[0] === 'writeAgentModel')).toEqual(['writeAgentModel', 'char-default', 'claude-haiku-4-5-20251001'])
  })

  it('a model in the request: the install default is not asked for', async () => {
    const r = await post({ name: 'char-model', description: 'x', model: 'claude-sonnet-5' })
    expect(r.calls.filter((c) => c[0] === 'launchableInstallDefault')).toEqual([])
  })
})

describe('POST /api/agents: the base writes, in order, with their arguments', () => {
  it('the full set: a custom provider and a display name that differs from the id', async () => {
    const r = await post({ name: '  My Agent ', description: 'x', model: 'claude-sonnet-5', customProvider: ' known-prov ', profile: ' researcher ' })
    expect(r.pastBaseWrites).toBe(true)
    expect(r.writes).toEqual([
      ['scaffoldAgentDir', 'my-agent'],
      ['writeAgentModel', 'my-agent', 'claude-sonnet-5'],
      ['writeAgentCustomProvider', 'my-agent', 'known-prov'],
      ['writeAgentSecurityProfile', 'my-agent', 'researcher'],
      ['writeAgentSettingsFromProfile', 'my-agent', { loadedProfile: 'researcher' }],
      ['seedContextGuardForNewAgent', 'my-agent'],
      ['writeAgentDisplayName', 'my-agent', 'My Agent'],
    ])
  })

  it('the minimal set: no provider write, no display-name write, the default profile', async () => {
    const r = await post({ name: 'char-min', description: 'x', model: 'claude-sonnet-5' })
    expect(r.pastBaseWrites).toBe(true)
    expect(r.writes).toEqual([
      ['scaffoldAgentDir', 'char-min'],
      ['writeAgentModel', 'char-min', 'claude-sonnet-5'],
      ['writeAgentSecurityProfile', 'char-min', 'default'],
      ['writeAgentSettingsFromProfile', 'char-min', { loadedProfile: 'default' }],
      ['seedContextGuardForNewAgent', 'char-min'],
    ])
  })

  it('a blank profile and a blank custom provider count as absent', async () => {
    const r = await post({ name: 'char-blank', description: 'x', model: 'claude-sonnet-5', profile: '   ', customProvider: '   ' })
    expect(r.writes.map((c) => c[0])).toEqual(['scaffoldAgentDir', 'writeAgentModel', 'writeAgentSecurityProfile', 'writeAgentSettingsFromProfile', 'seedContextGuardForNewAgent'])
    expect(r.writes[2]).toEqual(['writeAgentSecurityProfile', 'char-blank', 'default'])
  })
})
