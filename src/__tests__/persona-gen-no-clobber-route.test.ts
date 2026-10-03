import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// PERSONANOCLOBBER923, driven through the route itself (review of #1518).
//
// persona-gen-no-clobber.test.ts pins the guard function and, at source level,
// that a snapshot is taken before generation. Neither goes red if the handler
// hands the guard a snapshot taken at WRITE time instead of the pre-generation
// baseline -- measured by the maintainer: with
//   writePersonaFileIfUnchanged(f.path, snapshotPersonaFile(f.path), ...)
// the guard always answers "unchanged", the measured incident (a hand-written
// file overwritten by the template) is back, and all ten tests stay green.
//
// So this file runs POST /api/agents end to end with a generator the test
// holds open: the operator writes CLAUDE.md / SOUL.md INSIDE the generation
// window, then generation is released (or failed), and the files on disk, the
// sentinel, the main-agent notice and the response are what get asserted.
//
// Everything with a side effect outside the temp dir is stubbed: the agent
// directory, the model/profile/settings writers, the context-guard store row,
// and the DB message queue (a spy, so the notice is observable).

const h = vi.hoisted(() => ({
  root: '',
  createAgentMessage: vi.fn(),
  gen: null as null | {
    started: Promise<void>
    markStarted: () => void
    claude: { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void }
    soul: { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void }
  },
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(h.root, name),
    writeAgentModel: vi.fn(),
    writeAgentSecurityProfile: vi.fn(),
    writeAgentDisplayName: vi.fn(),
    listAgentNames: () => [],
  }
})

vi.mock('../web/agent-scaffold.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-scaffold.js')>()
  return {
    ...orig,
    scaffoldAgentDir: (name: string) => { mkdirSync(join(h.root, name), { recursive: true }) },
    writeAgentSettingsFromProfile: vi.fn(),
    generateClaudeMd: () => { h.gen!.markStarted(); return h.gen!.claude.promise },
    generateSoulMd: () => { h.gen!.markStarted(); return h.gen!.soul.promise },
  }
})

vi.mock('../web/context-guard-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/context-guard-store.js')>()
  return { ...orig, seedContextGuardForNewAgent: vi.fn(() => null) }
})

vi.mock('../web/profiles.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/profiles.js')>()
  return { ...orig, loadProfileTemplate: vi.fn(() => ({})) }
})

vi.mock('../db.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db.js')>()
  return { ...orig, createAgentMessage: h.createAgentMessage }
})

const { tryHandleAgents, PERSONALITY_PENDING_SENTINEL } = await import('../web/routes/agents.js')
const { CLI_VERSION_OVERRIDE_ENV, resetClaudeCliVersionCache } = await import('../web/claude-cli-version.js')
const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
type RouteContext = import('../web/routes/types.js').RouteContext

const NAME = 'zz-persona-noclobber-probe'
const HAND_CLAUDE = '# kezi CLAUDE\n\n## Tiltasok\n- Soha ne kuldj levelet jovahagyas nelkul.\n'
const HAND_SOUL = '# kezi SOUL\n\nKezzel irt hangnem.\n'
const GEN_CLAUDE = '# generalt CLAUDE\n'
const GEN_SOUL = '# generalt SOUL\n'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  // A rejection the handler has not attached to yet must not surface as an
  // unhandled rejection; the handler's own await still observes it.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function startCreate(): Promise<{ status: number; body: Record<string, any> }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out = { status: 0, body: {} as Record<string, any> }
  const res = {
    setHeader() {},
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL('http://localhost:3420/api/agents')
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify({ name: NAME, description: 'probe agent' })))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return tryHandleAgents(
    { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  ).then((handled) => {
    expect(handled).toBe(true)
    return out
  })
}

const dir = () => join(h.root, NAME)
const read = (file: string) => readFileSync(join(dir(), file), 'utf8')
/** The skip notice, as opposed to the "new team member" greeting. */
const skipNotices = () => h.createAgentMessage.mock.calls.filter(
  (c) => typeof c[2] === 'string' && c[2].includes('NEM írta felül'),
)

const savedCliEnv = process.env[CLI_VERSION_OVERRIDE_ENV]
beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'persona-route-'))
  let markStarted!: () => void
  const started = new Promise<void>((r) => { markStarted = r })
  h.gen = { started, markStarted, claude: deferred<string>(), soul: deferred<string>() }
  h.createAgentMessage.mockReset()
  // Unmeasured CLI = the model gate fails open; this test is not about it.
  process.env[CLI_VERSION_OVERRIDE_ENV] = ''
  resetClaudeCliVersionCache()
})
afterEach(() => { rmSync(h.root, { recursive: true, force: true }) })
afterAll(() => {
  if (savedCliEnv === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]
  else process.env[CLI_VERSION_OVERRIDE_ENV] = savedCliEnv
})

describe('POST /api/agents: files hand-written DURING generation survive (pre-generation baseline)', () => {
  it('generation SUCCEEDS: both hand-written files kept, generated text goes to *.generated.md, main agent told', async () => {
    const pending = startCreate()
    await h.gen!.started // snapshot taken, generation in flight
    writeFileSync(join(dir(), 'CLAUDE.md'), HAND_CLAUDE)
    writeFileSync(join(dir(), 'SOUL.md'), HAND_SOUL)
    h.gen!.claude.resolve(GEN_CLAUDE)
    h.gen!.soul.resolve(GEN_SOUL)
    const r = await pending

    expect(read('CLAUDE.md')).toBe(HAND_CLAUDE)
    expect(read('SOUL.md')).toBe(HAND_SOUL)
    expect(read('CLAUDE.generated.md')).toBe(GEN_CLAUDE)
    expect(read('SOUL.generated.md')).toBe(GEN_SOUL)
    expect(existsSync(join(dir(), PERSONALITY_PENDING_SENTINEL))).toBe(false)

    expect(r.status).toBe(200)
    expect(r.body.personalityPending).toBeUndefined()
    expect(r.body.personalitySkipped).toEqual([
      { file: 'CLAUDE.md', generatedPath: join(dir(), 'CLAUDE.generated.md') },
      { file: 'SOUL.md', generatedPath: join(dir(), 'SOUL.generated.md') },
    ])

    // "The skip is never silent": exactly one notice, to the main agent,
    // naming both files and where the generated text went.
    const notices = skipNotices()
    expect(notices).toHaveLength(1)
    const [from, to, text] = notices[0]
    expect(from).toBe('system')
    expect(to).toBe(MAIN_AGENT_ID)
    expect(text).toContain(NAME)
    expect(text).toContain('CLAUDE.md')
    expect(text).toContain('SOUL.md')
    expect(text).toContain(join(dir(), 'CLAUDE.generated.md'))
    expect(text).toContain(join(dir(), 'SOUL.generated.md'))
  })

  it('generation FAILS (the measured incident): no template over the hand-written files, NO sentinel, main agent told', async () => {
    const pending = startCreate()
    await h.gen!.started
    writeFileSync(join(dir(), 'CLAUDE.md'), HAND_CLAUDE)
    writeFileSync(join(dir(), 'SOUL.md'), HAND_SOUL)
    h.gen!.claude.reject(new Error('generation timed out'))
    h.gen!.soul.reject(new Error('generation timed out'))
    const r = await pending

    expect(read('CLAUDE.md')).toBe(HAND_CLAUDE)
    expect(read('SOUL.md')).toBe(HAND_SOUL)
    expect(read('CLAUDE.md')).not.toContain('SABLON')
    // No placeholder landed, so nothing may claim the personality is one.
    expect(existsSync(join(dir(), PERSONALITY_PENDING_SENTINEL))).toBe(false)
    // A template has nothing worth keeping: no sidecar on this path.
    expect(existsSync(join(dir(), 'CLAUDE.generated.md'))).toBe(false)
    expect(existsSync(join(dir(), 'SOUL.generated.md'))).toBe(false)

    expect(r.status).toBe(200)
    expect(r.body.personalityPending).toBeUndefined()
    expect(r.body.personalitySkipped).toEqual([
      { file: 'CLAUDE.md', generatedPath: null },
      { file: 'SOUL.md', generatedPath: null },
    ])

    const notices = skipNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0][0]).toBe('system')
    expect(notices[0][1]).toBe(MAIN_AGENT_ID)
    expect(notices[0][2]).toContain('CLAUDE.md')
    expect(notices[0][2]).toContain('SOUL.md')
  })

  it('generation FAILS, only CLAUDE.md hand-written: template lands on SOUL.md alone, sentinel written, both reported', async () => {
    const pending = startCreate()
    await h.gen!.started
    writeFileSync(join(dir(), 'CLAUDE.md'), HAND_CLAUDE)
    h.gen!.claude.reject(new Error('boom'))
    h.gen!.soul.reject(new Error('boom'))
    const r = await pending

    expect(read('CLAUDE.md')).toBe(HAND_CLAUDE)
    expect(read('SOUL.md')).toContain('SABLON')
    expect(existsSync(join(dir(), PERSONALITY_PENDING_SENTINEL))).toBe(true)
    expect(r.body.personalityPending).toBe(true)
    expect(r.body.personalitySkipped).toEqual([{ file: 'CLAUDE.md', generatedPath: null }])
    expect(skipNotices()).toHaveLength(1)
    expect(skipNotices()[0][2]).toContain('CLAUDE.md')
    expect(skipNotices()[0][2]).not.toContain('SOUL.md')
  })
})

describe('POST /api/agents: untouched files still get written (the guard is not a blanket skip)', () => {
  it('generation SUCCEEDS, nobody touched the files: generated text written, no sidecar, no skip notice', async () => {
    const pending = startCreate()
    await h.gen!.started
    h.gen!.claude.resolve(GEN_CLAUDE)
    h.gen!.soul.resolve(GEN_SOUL)
    const r = await pending

    expect(read('CLAUDE.md')).toBe(GEN_CLAUDE)
    expect(read('SOUL.md')).toBe(GEN_SOUL)
    expect(existsSync(join(dir(), 'CLAUDE.generated.md'))).toBe(false)
    expect(r.body).toEqual({ ok: true, name: NAME })
    expect(skipNotices()).toHaveLength(0)
  })

  it('generation FAILS, nobody touched the files: template written, sentinel written, no skip notice', async () => {
    const pending = startCreate()
    await h.gen!.started
    h.gen!.claude.reject(new Error('boom'))
    h.gen!.soul.reject(new Error('boom'))
    const r = await pending

    expect(read('CLAUDE.md')).toContain('SABLON')
    expect(existsSync(join(dir(), PERSONALITY_PENDING_SENTINEL))).toBe(true)
    expect(r.body.personalityPending).toBe(true)
    expect(r.body.personalitySkipped).toBeUndefined()
    expect(skipNotices()).toHaveLength(0)
  })
})
