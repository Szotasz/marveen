/**
 * PICKERCLIKAPU923: the model picker is gated by the INSTALLED Claude Code
 * CLI, on the wire (/api/models/available), at the writers (POST/PUT model)
 * and in the served client. Both branches are measured, not declared:
 * measured version -> unsupported models refused / disabled; unmeasured ->
 * nothing refused, hint shown.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryHandleAgents, refuseIfCliCannotLaunch } from '../web/routes/agents.js'
import { measureClaudeCliVersion, resetClaudeCliVersionCache, CLI_VERSION_OVERRIDE_ENV } from '../web/claude-cli-version.js'
import type { RouteContext } from '../web/routes/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..', '..')
const indexHtml = readFileSync(join(REPO, 'web', 'index.html'), 'utf8')
const appSource = readFileSync(join(REPO, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(REPO, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(REPO, 'web', 'lang', 'en.js'), 'utf8')

const savedEnv = process.env[CLI_VERSION_OVERRIDE_ENV]
afterAll(() => { if (savedEnv === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]; else process.env[CLI_VERSION_OVERRIDE_ENV] = savedEnv })
beforeEach(() => resetClaudeCliVersionCache())

async function getModels(): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  let status = 200; let body = ''
  const res = { statusCode: 200, setHeader() {}, writeHead(s: number) { status = s }, end(chunk?: string) { body = String(chunk ?? '') } } as unknown as RouteContext['res']
  const url = new URL('http://127.0.0.1/api/models/available')
  const handled = await tryHandleAgents({ req, res, path: '/api/models/available', method: 'GET', url } as RouteContext, join(REPO, 'web'))
  expect(handled).toBe(true)
  return { status, body: JSON.parse(body) }
}

describe('measurer override and cache', () => {
  it('the env override is a measurement: a version filters, an empty value is UNMEASURED', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110 (Claude Code)'
    expect((await measureClaudeCliVersion()).version).toBe('2.1.110')
    process.env[CLI_VERSION_OVERRIDE_ENV] = ''
    const r = await measureClaudeCliVersion()
    expect(r.version).toBeNull()
    expect(r.error).toBeTruthy()
  })
})

describe('/api/models/available carries the gate', () => {
  it('MEASURED 2.1.110: cli.version set, claudeSupport lists fable-5-1 and opus-5-5, and the claude array is in sync with the picker', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const { status, body } = await getModels()
    expect(status).toBe(200)
    expect((body.cli as { version: string }).version).toBe('2.1.110')
    const s = body.claudeSupport as { measured: boolean; unsupported: Array<{ id: string }> }
    expect(s.measured).toBe(true)
    expect(s.unsupported.map((u) => u.id).sort()).toEqual(['claude-fable-5-1', 'claude-opus-5-5'])
    const ids = (body.claude as Array<{ id: string }>).map((m) => m.id)
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5', 'claude-sonnet-5']) expect(ids).toContain(id)
    // the picker markup offers exactly the same Claude ids the API lists
    for (const id of ids) expect(indexHtml, id).toContain(`<option value="${id}"`)
  })
  it('UNMEASURED: cli.version null with an error, claudeSupport.measured false and NOTHING unsupported (fail-open)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = ''
    const { body } = await getModels()
    expect((body.cli as { version: null; error: string }).version).toBeNull()
    expect((body.cli as { error: string }).error).toBeTruthy()
    const s = body.claudeSupport as { measured: boolean; unsupported: unknown[] }
    expect(s.measured).toBe(false)
    expect(s.unsupported).toEqual([])
  })
})

describe('the writers are gated too (POST/PUT model)', () => {
  it('MEASURED 2.1.110 refuses opus-5-5 and fable-5-1 with 422 that names the versions, and lets opus-5 through', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const r = await refuseIfCliCannotLaunch('claude-opus-5-5[1m]')
    expect(r).not.toBeNull()
    expect(r!.installedCli).toBe('2.1.110')
    expect(r!.minCli).toBe('2.1.280')
    expect(String(r!.message)).toContain('2.1.110')
    expect(await refuseIfCliCannotLaunch('claude-fable-5-1')).not.toBeNull()
    expect(await refuseIfCliCannotLaunch('claude-opus-5')).toBeNull()
  })
  it('UNMEASURED refuses nothing, including the models refused above', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = ''
    expect(await refuseIfCliCannotLaunch('claude-opus-5-5')).toBeNull()
    expect(await refuseIfCliCannotLaunch('claude-fable-5-1')).toBeNull()
  })
  it('the PUT handler consults the gate before writing the model (binding pin, not only the function)', () => {
    const src = readFileSync(join(REPO, 'src', 'web', 'routes', 'agents.ts'), 'utf8')
    const put = src.indexOf("if (data.model !== undefined) {")
    expect(put).toBeGreaterThan(-1)
    expect(src.slice(put, put + 400)).toContain('refuseIfCliCannotLaunch(String(data.model))')
    const post = src.indexOf("const cliGate = await refuseIfCliCannotLaunch(model)")
    expect(post).toBeGreaterThan(-1)
  })
})

describe('the served client', () => {
  it('both selects offer Opus 5.5 and Opus 5.5[1m], and both carry a CLI hint element', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]']) {
      expect(indexHtml.split(`<option value="${id}"`).length - 1, id).toBe(2)
    }
    expect(indexHtml).toContain('id="agentModelCliHint"')
    expect(indexHtml).toContain('id="editAgentModelCliHint"')
  })
  it('loadAvailableModels() applies the gate from data.claudeSupport, disables only non-current unsupported options, and shows the hint when unmeasured', () => {
    const start = appSource.indexOf('function applyClaudeCliGate(data)')
    expect(start).toBeGreaterThan(-1)
    const end = appSource.indexOf('async function loadAvailableModels()', start)
    const body = appSource.slice(start, end)
    expect(body).toContain('support.measured')
    expect(body).toContain('opt.disabled = opt.value !== current')
    expect(body).toContain("t('agents.model.cliUnmeasured')")
    expect(body).toContain("t('agents.model.cliUnsupported')")
    const loader = appSource.slice(end, appSource.indexOf('\n// --- OpenRouter manual-list curation', end))
    expect(loader).toContain('applyClaudeCliGate(data)')
  })
  it('both languages carry the four new keys', () => {
    for (const k of ['agents.model.opus55', 'agents.model.opus55_1m', 'agents.model.cliUnsupported', 'agents.model.cliUnmeasured']) {
      expect(hu, k).toContain(`'${k}'`)
      expect(en, k).toContain(`'${k}'`)
    }
  })
})
