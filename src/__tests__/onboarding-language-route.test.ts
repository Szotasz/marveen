// DOCKERUX1118 (Samu 80886): POST /api/onboarding/language, the wizard's install language switch. Docker only, the
// owner session only (never the bare first-run token), only while the setup is unfinished; a main agent that runs
// already is restarted after the switch (HOSTINGERI18N1122), one that starts during it refuses; a refusal changes no file. The route runs on a throwaway install with the REAL templates and render;
// the seeds' script is a stub in the docker dir (its own test: lang-switch-seeds.test.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => ({ root: '', dropLangWrite: false, restart: { calls: 0, result: { ok: true } as { ok: boolean; error?: string } } }))
// A test can make the .lang write a silent no-op, so the read-back before the restart sees the old language.
vi.mock('../web/atomic-write.js', async (orig) => {
  const a = await orig<typeof import('../web/atomic-write.js')>()
  return { ...a, atomicWriteFileSync: (...args: Parameters<typeof a.atomicWriteFileSync>) => (H.dropLangWrite && String(args[0]).endsWith('/.lang') ? undefined : a.atomicWriteFileSync(...args)) }
})
vi.mock('../web/channel-monitor.js', async (orig) => {
  const a = await orig<typeof import('../web/channel-monitor.js')>()
  return { ...a, hardRestartMarveenChannels: () => { H.restart.calls++; return H.restart.result } }
})
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
// The main channel's state (bot token, access.json): a test pairs the channel or finishes the setup through it.
const TG = join(tmpRoot, 'tg-state')
mkdirSync(TG, { recursive: true })
const origTgDir = process.env.TELEGRAM_STATE_DIR
process.env.TELEGRAM_STATE_DIR = TG

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
  if (origTgDir === undefined) delete process.env.TELEGRAM_STATE_DIR
  else process.env.TELEGRAM_STATE_DIR = origTgDir
  rmSync(tmpRoot, { recursive: true, force: true })
})

const ENV = join(tmpRoot, '.env')
const ENV_DOCKER = 'MAIN_AGENT_ID=marveen\nBOT_NAME=Marveen\nOWNER_NAME=Owner\nWEB_PORT=3420\nMARVEEN_DEPLOYMENT=docker\nAGENT_TEXT_LANG=en\nDASHBOARD_LANG=en\n'
const CLAUDE_EN = '# a hand-made persona that no template renders\n'
beforeEach(() => {
  writeFileSync(ENV, ENV_DOCKER, { mode: 0o600 })
  writeFileSync(join(tmpRoot, 'CLAUDE.md'), CLAUDE_EN)
  rmSync(join(tmpRoot, 'SOUL.md'), { force: true })
  rmSync(join(tmpRoot, '.lang'), { force: true })
  rmSync(RUNNING, { force: true })
  rmSync(LATE, { force: true })
  rmSync(COUNT, { force: true })
  H.restart = { calls: 0, result: { ok: true } }
  H.dropLangWrite = false
  rmSync(join(TG, 'access.json'), { force: true })
  rmSync(join(TG, '.env'), { force: true })
  writeFileSync(SEEDS, SEEDS_OK)
})
const SEEDS = join(dockerDir, 'lang-switch-seeds.sh')
const SEEDS_OK = '#!/bin/bash\necho "seed updated .claude/skills/alpha/SKILL.md"\n'
const pairChannel = () => writeFileSync(join(TG, 'access.json'), JSON.stringify({ allowFrom: ['12345'] }))

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

  // HOSTINGERI18N1122: in the container the main agent runs from boot (supervisor starts channels.sh), so the old
  // refusal failed the wizard's switch on every Docker install (measured on the develop image).
  it('the main agent already runs during the setup, channel unpaired (a fresh Docker install): switched, read back, restarted once', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    expect((await call('GET', '/api/onboarding/status')).json.agentsRunning).toBe(true)
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.ok, r.json.lang, r.json.restarted]).toEqual([200, true, 'hu', true])
    expect(readFileSync(ENV, 'utf-8')).toContain('AGENT_TEXT_LANG=hu\n')
    expect(readFileSync(join(tmpRoot, '.lang'), 'utf-8')).toBe('hu\n')
    expect(H.restart.calls).toBe(1)
  })

  it('the restart fails after the switch: 500 restart-failed, the language is switched, the command is said; the retry restarts', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    H.restart.result = { ok: false, error: 'respawn-pane failed' }
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.ok, r.json.reason, r.json.restarted]).toEqual([500, false, 'restart-failed', false])
    expect(r.json.error).toContain('respawn-pane failed')
    expect(typeof r.json.restartCommand).toBe('string')
    expect(readFileSync(join(tmpRoot, '.lang'), 'utf-8')).toBe('hu\n')
    // The retry (the wizard's click again) finds the language switched and pays the restart it still owes.
    H.restart.result = { ok: true }
    const again = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([again.status, again.json.ok, again.json.restarted]).toEqual([200, true, true])
    expect(H.restart.calls).toBe(2)
  })

  it('the language does not read back after the switch: 500 readback-failed, no restart; owed to the retry', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    H.dropLangWrite = true
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.ok, r.json.reason, r.json.restarted]).toEqual([500, false, 'readback-failed', false])
    expect(H.restart.calls).toBe(0)
    // Once .lang holds the language, the retry reads it back and pays the owed restart.
    H.dropLangWrite = false
    writeFileSync(join(tmpRoot, '.lang'), 'hu\n')
    const again = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([again.status, again.json.restarted]).toEqual([200, true])
  })

  it('the channel is paired during the switch (Dani 82930): switched, 409 paired_during_switch, no restart', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    // The seeds' step runs inside the switch, after the persona writes: it pairs the channel there.
    writeFileSync(SEEDS, `#!/bin/bash\nprintf '{"allowFrom":["12345"]}' > '${join(TG, 'access.json')}'\necho "seed updated .claude/skills/alpha/SKILL.md"\n`)
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.ok, r.json.reason, r.json.restarted]).toEqual([409, false, 'paired_during_switch', false])
    expect(readFileSync(join(tmpRoot, '.lang'), 'utf-8')).toBe('hu\n')
    expect(H.restart.calls).toBe(0)
  })

  it('the switch itself fails over the setup session: no restart; the retry finds it switched and pays the owed restart once', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    writeFileSync(SEEDS, '#!/bin/bash\nexit 3\n')
    const bad = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([bad.status, bad.json.ok, bad.json.error]).toEqual([500, false, 'seed_refresh_failed'])
    expect(H.restart.calls).toBe(0)
    writeFileSync(SEEDS, SEEDS_OK)
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.ok, r.json.restarted]).toEqual([200, true, true])
    // The first attempt switched the env, .lang and the persona before the seeds failed, so the retry has nothing left to
    // render (the seeds' snapshot finishes them on the container's next start, install-lang-switch.ts); it still owes
    // and pays the restart.
    expect(r.json.files).toEqual([])
    expect(readFileSync(ENV, 'utf-8')).toContain('AGENT_TEXT_LANG=hu\n')
    expect(readFileSync(join(tmpRoot, '.lang'), 'utf-8')).toBe('hu\n')
    expect(H.restart.calls).toBe(1)
  })

  it('the main agent runs with a PAIRED channel, setup not finished (the router install model): 409, no restart', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    pairChannel()
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.reason]).toEqual([409, 'agent_running'])
    expect(r.json.error).toContain('is already running')
    expect(H.restart.calls).toBe(0)
    untouched()
  })

  it('a finished setup with the agent running: 409 onboarding_done, no restart (the done check comes first)', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    pairChannel()
    writeFileSync(join(TG, '.env'), 'TELEGRAM_BOT_TOKEN=123456:test-token-value\n')
    writeFileSync(ENV, ENV_DOCKER + 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n', { mode: 0o600 })
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'hu' })
    expect([r.status, r.json.reason]).toEqual([409, 'onboarding_done'])
    expect(H.restart.calls).toBe(0)
    expect(existsSync(join(tmpRoot, '.lang'))).toBe(false)
  })

  it('the main agent runs and the language is the same: nothing rendered, no restart', async () => {
    writeFileSync(RUNNING, MAIN_CHANNELS_SESSION + '\n')
    const r = await call('POST', '/api/onboarding/language', OWNER, { lang: 'en' })
    expect([r.status, r.json.ok, r.json.files]).toEqual([200, true, []])
    expect(H.restart.calls).toBe(0)
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
    expect(H.restart.calls).toBe(0)
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
    expect(H.restart.calls).toBe(0)
  })
})
