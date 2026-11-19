// DOCKERUX1118 (Samu 80886): POST /api/onboarding/language, the wizard's install language switch. Docker only, the
// owner session only (never the bare first-run token), only while the main agent is not running and the setup is
// unfinished; a refusal changes no file. The route runs on a throwaway install with the REAL templates and render;
// the seeds' script is a stub in the docker dir (its own test: lang-switch-seeds.test.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, CHANNEL_PROVIDER: 'telegram' as const }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})

const REPO = join(__dirname, '..', '..')
const tmpRoot = mkdtempSync(join(tmpdir(), 'onb-lang-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })
mkdirSync(join(tmpRoot, 'scripts', 'lib'), { recursive: true })
for (const f of ['seed-refresh.sh', 'install-tz.sh']) cpSync(join(REPO, 'scripts', 'lib', f), join(tmpRoot, 'scripts', 'lib', f))
cpSync(join(REPO, 'templates', 'CLAUDE.md.template'), join(tmpRoot, 'templates', 'CLAUDE.md.template'))
cpSync(join(REPO, 'templates', 'SOUL.md.template'), join(tmpRoot, 'templates', 'SOUL.md.template'))
cpSync(join(REPO, 'templates', 'en'), join(tmpRoot, 'templates', 'en'), { recursive: true })
// The seeds' script: a stub that reports one file.
const dockerDir = join(tmpRoot, 'docker-dir')
mkdirSync(dockerDir, { recursive: true })
writeFileSync(join(dockerDir, 'lang-switch-seeds.sh'), '#!/bin/bash\necho "seed updated .claude/skills/alpha/SKILL.md"\n')
// tmux: "list-sessions" prints the flag file (the main channels session's name), so a test can say the agent runs.
const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
const RUNNING = join(tmpRoot, 'agent-running')
// LATE: the agent "starts" from the second list-sessions on (the route asks first, the switch asks again before writing).
const LATE = join(tmpRoot, 'agent-starts-late')
const COUNT = join(tmpRoot, 'tmux-calls')
writeFileSync(join(binDir, 'tmux'), [
  '#!/bin/sh',
  `[ -f '${RUNNING}' ] && cat '${RUNNING}' && exit 0`,
  `if [ -f '${LATE}' ]; then n=$(cat '${COUNT}' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${COUNT}'; [ "$n" -ge 2 ] && cat '${LATE}' && exit 0; fi`,
  'exit 1',
  '',
].join('\n'))
chmodSync(join(binDir, 'tmux'), 0o755)
const origPath = process.env.PATH
const origDockerDir = process.env.MARVEEN_DOCKER_DIR
const origEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.PATH = `${binDir}:${origPath ?? ''}`
process.env.MARVEEN_DOCKER_DIR = dockerDir
// src/env.ts (deployment(), installLang) reads its .env from here, at import time.
process.env.CLAUDECLAW_ENV_DIR = tmpRoot

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
const { MAIN_CHANNELS_SESSION } = await import('../web/main-agent.js')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' }) })
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = origPath
  if (origDockerDir === undefined) delete process.env.MARVEEN_DOCKER_DIR
  else process.env.MARVEEN_DOCKER_DIR = origDockerDir
  if (origEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = origEnvDir
  rmSync(tmpRoot, { recursive: true, force: true })
})

const ENV = join(tmpRoot, '.env')
const ENV_DOCKER = 'MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=Owner\nWEB_PORT=3420\nMARVEEN_DEPLOYMENT=docker\nAGENT_TEXT_LANG=en\nDASHBOARD_LANG=en\n'
const CLAUDE_EN = '# a hand-made persona that no template renders\n'
beforeEach(() => {
  writeFileSync(ENV, ENV_DOCKER, { mode: 0o600 })
  writeFileSync(join(tmpRoot, 'CLAUDE.md'), CLAUDE_EN)
  rmSync(join(tmpRoot, 'SOUL.md'), { force: true })
  rmSync(RUNNING, { force: true })
  rmSync(LATE, { force: true })
  rmSync(COUNT, { force: true })
})

async function call(method: string, path: string, auth?: unknown, body?: unknown) {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } })
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL(`http://localhost${path}`)
  const handled = await tryHandleOnboarding({ req, res, path: url.pathname, method, url, auth } as any)
  return { handled, status, json: out ? JSON.parse(out) : null }
}
const OWNER = { kind: 'session', user: 'owner' }
const NOT_OWNER = [undefined, { kind: 'token' }, { kind: 'device', scope: 'full', device: 'Bridge' }, { kind: 'device', scope: 'operator', device: 'Op' }]
const untouched = () => {
  expect(readFileSync(ENV, 'utf-8')).toBe(ENV_DOCKER)
  expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toBe(CLAUDE_EN)
}

describe('POST /api/onboarding/language (DOCKERUX1118)', () => {
  it('the status names the deployment and the install language', async () => {
    const r = await call('GET', '/api/onboarding/status')
    expect([r.json.deployment, r.json.installLang]).toEqual(['docker', 'en'])
  })

  it('not the owner (no auth, the bare token, a Bridge key alone, an operator key): 403, nothing changes', async () => {
    for (const auth of NOT_OWNER) {
      const r = await call('POST', '/api/onboarding/language', auth, { lang: 'hu' })
      expect([JSON.stringify(auth), r.status, r.json.code]).toEqual([JSON.stringify(auth), 403, 'owner_session_required'])
    }
    untouched()
  })

  it.each<[string, unknown]>([['another language', { lang: 'de' }], ['no lang', {}], ['not JSON', 'lang=hu']])('%s: 400', async (_l, body) => {
    const r = await call('POST', '/api/onboarding/language', OWNER, body)
    expect([r.status, r.json.reason]).toEqual([400, 'bad-lang'])
    untouched()
  })

  it('a native install: 409 not_docker, nothing changes', async () => {
    writeFileSync(ENV, ENV_DOCKER.replace('MARVEEN_DEPLOYMENT=docker\n', ''))
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.reason]).toEqual([409, 'not_docker'])
    expect(r.json.error).toContain('only in the Docker container')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toBe(CLAUDE_EN)
  })

  it('the main agent runs: 409 agent_running, nothing changes', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    expect((await call('GET', '/api/onboarding/status')).json.agentsRunning).toBe(true)
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.reason]).toEqual([409, 'agent_running'])
    untouched()
  })

  it('the main agent starts after the route\'s check, before the writes (Dani 80955 n2): 409 agent_running, nothing changes', async () => {
    writeFileSync(LATE, MAIN_CHANNELS_SESSION + '\n')
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.reason]).toEqual([409, 'agent_running'])
    expect(r.json.error).toContain('nothing was changed')
    expect(readFileSync(COUNT, 'utf-8').trim()).toBe('2')
    untouched()
    expect(existsSync(join(tmpRoot, '.lang'))).toBe(false)
  })

  it('the owner, in the container, during the setup: switched; an edited CLAUDE.md is kept and said so', async () => {
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({
      ok: true,
      lang: 'hu',
      previous: 'en',
      files: [
        { file: 'CLAUDE.md', result: 'kept_customized' },
        { file: 'SOUL.md', result: 'unchanged' },
        { file: '.claude/skills/alpha/SKILL.md', result: 're-rendered' },
      ],
    })
    const env = readFileSync(ENV, 'utf-8')
    expect(env).toContain('AGENT_TEXT_LANG=hu\n')
    expect(env).toContain('DASHBOARD_LANG=hu\n')
    expect(env).not.toContain('AGENT_TEXT_LANG=en')
    expect(readFileSync(join(tmpRoot, '.lang'), 'utf-8')).toBe('hu\n')
    expect(readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')).toBe(CLAUDE_EN)
    expect(existsSync(join(tmpRoot, 'SOUL.md'))).toBe(false)
    expect((await call('GET', '/api/onboarding/status')).json.installLang).toBe('hu')
  })
})
