import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideCliOffer, readAvxSafePin, detectInstallMethod, probeClaudeLaunches, fetchLatestVersion,
  resetLatestVersionCache, buildCliUpdateStatus, startCliUpdate, setCliUpdateDepsForTests,
  RUNNING_SESSIONS_NOTE, REGISTRY_LATEST_URL, readCliUpdateResult,
} from '../web/cli-update.js'
import { tryHandleUpdates } from '../web/routes/updates.js'
import type { RouteContext } from '../web/routes/types.js'

// CLIFRISSAJANLAS923: the update page OFFERS a Claude Code CLI update. Every
// rule below is a measured constraint from the card, not a preference:
//   1. an AVX-less host is never offered "latest" (the Bun ELF does not run
//      there); its target is the installer's AVX-safe pin, or nothing;
//   3. the post-install verification is a real, auth-free `-p` probe;
//   4. the result carries the note that running sessions keep the old binary.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')

describe('decideCliOffer (rule 1: AVX-less never gets latest, fail-closed on the unmeasured)', () => {
  it('avx-less + no pin: nothing, whatever latest says', () => {
    const d = decideCliOffer({ installed: '2.1.110', latest: '2.1.280', avxLess: true, avxSafePin: null })
    expect(d).toMatchObject({ target: null, targetKind: null, offer: false })
  })
  it('avx-less + pin newer than installed: the pin is offered, not latest', () => {
    const d = decideCliOffer({ installed: '2.1.110', latest: '2.1.280', avxLess: true, avxSafePin: '2.1.112' })
    expect(d).toMatchObject({ target: '2.1.112', targetKind: 'avx-safe-pin', offer: true })
  })
  it('avx-less + installed at/above the pin: no offer (and still never latest)', () => {
    expect(decideCliOffer({ installed: '2.1.112', latest: '2.1.280', avxLess: true, avxSafePin: '2.1.112' }).offer).toBe(false)
    expect(decideCliOffer({ installed: '2.1.280', latest: '2.1.300', avxLess: true, avxSafePin: '2.1.112' })).toMatchObject({ target: '2.1.112', offer: false })
  })
  it('avx-capable: latest newer -> offer latest; equal -> no offer; unknown latest -> nothing', () => {
    expect(decideCliOffer({ installed: '2.1.278', latest: '2.1.280', avxLess: false, avxSafePin: '2.1.112' })).toMatchObject({ target: '2.1.280', targetKind: 'latest', offer: true })
    expect(decideCliOffer({ installed: '2.1.280', latest: '2.1.280', avxLess: false, avxSafePin: '2.1.112' }).offer).toBe(false)
    expect(decideCliOffer({ installed: '2.1.278', latest: null, avxLess: false, avxSafePin: '2.1.112' })).toMatchObject({ target: null, offer: false })
  })
  it('unmeasured installed version: a target may be shown, but nothing is offered', () => {
    expect(decideCliOffer({ installed: null, latest: '2.1.280', avxLess: false, avxSafePin: null })).toMatchObject({ target: '2.1.280', offer: false })
    expect(decideCliOffer({ installed: null, latest: null, avxLess: true, avxSafePin: '2.1.112' })).toMatchObject({ target: '2.1.112', offer: false })
  })
})

describe('the AVX-safe pin is read from the shipped installer (single source)', () => {
  it('matches install-linux.sh CLAUDE_PIN exactly', () => {
    const fromScript = LINUX.match(/^CLAUDE_PIN="([^"]+)"/m)![1]
    expect(readAvxSafePin(LINUX)).toBe(fromScript)
    expect(fromScript).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('a script without the pin, or a non-version pin, yields null', () => {
    expect(readAvxSafePin('echo hi')).toBeNull()
    expect(readAvxSafePin('CLAUDE_PIN="latest"')).toBeNull()
  })
})

describe('detectInstallMethod', () => {
  it('node_modules -> npm; ~/.local/share/claude -> official; other -> unknown; none -> unknown', () => {
    expect(detectInstallMethod('/usr/bin/claude', () => '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('npm')
    expect(detectInstallMethod('/home/u/.local/bin/claude', () => '/home/u/.local/share/claude/versions/2.1.280')).toBe('official')
    expect(detectInstallMethod('/opt/weird/claude', () => '/opt/weird/claude')).toBe('unknown')
    expect(detectInstallMethod(null)).toBe('unknown')
  })
})

function mockClaude(kind: 'healthy' | 'spin' | 'crash', envLog: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliupd-'))
  const body = [
    '#!/bin/bash',
    'if [ "$1" = "--version" ]; then echo "2.1.280 (Claude Code)"; exit 0; fi',
    `printf 'CFG=%s\\nOAUTH=%s\\nAPIKEY=%s\\nAUTHTOK=%s\\n' "\${CLAUDE_CONFIG_DIR:-}" "\${CLAUDE_CODE_OAUTH_TOKEN:-unset}" "\${ANTHROPIC_API_KEY:-unset}" "\${ANTHROPIC_AUTH_TOKEN:-unset}" > "${envLog}"`,
    kind === 'healthy' ? 'echo \'{"is_error":true,"result":"Not logged in"}\'; exit 1' : kind === 'spin' ? 'sleep 30; exit 0' : 'kill -ILL $$',
  ].join('\n')
  const bin = join(dir, 'claude')
  writeFileSync(bin, body + '\n'); chmodSync(bin, 0o755)
  return bin
}

describe('probeClaudeLaunches (rule 3: a real -p, auth-free, isolated, cleaned up)', () => {
  it('healthy: exit 1 fast -> ok; auth env absent even when set outside; config dir isolated and removed', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'cliupd-log-')), 'env')
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'leak-oauth'
    process.env.ANTHROPIC_API_KEY = 'leak-key'
    try {
      const r = await probeClaudeLaunches(mockClaude('healthy', log), 5000)
      expect(r.ok).toBe(true)
      expect(r.exitCode).toBe(1)
      const seen = Object.fromEntries(readFileSync(log, 'utf-8').trim().split('\n').map((l) => l.split('=', 2)))
      expect(seen.OAUTH).toBe('unset')
      expect(seen.APIKEY).toBe('unset')
      expect(seen.AUTHTOK).toBe('unset')
      expect(seen.CFG).toContain('claude-probe-')
      expect(existsSync(seen.CFG)).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_API_KEY
    }
  })
  it('spin: hangs -> killed at the timeout -> not ok', async () => {
    const r = await probeClaudeLaunches(mockClaude('spin', join(mkdtempSync(join(tmpdir(), 'cliupd-log-')), 'env')), 1500)
    expect(r.ok).toBe(false)
    expect(r.signal).toBe('TIMEOUT')
  }, 10_000)
  it('crash: SIGILL -> not ok', async () => {
    const r = await probeClaudeLaunches(mockClaude('crash', join(mkdtempSync(join(tmpdir(), 'cliupd-log-')), 'env')), 5000)
    expect(r.ok).toBe(false)
    expect(r.exitCode === null || r.exitCode >= 128).toBe(true)
  })
})

describe('fetchLatestVersion', () => {
  afterEach(() => resetLatestVersionCache())
  const fake = (status: number, body: unknown) => (async (url: string | URL | Request) => {
    expect(String(url)).toBe(REGISTRY_LATEST_URL)
    return { ok: status === 200, status, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  it('a registry answer with a dotted version is the latest', async () => {
    expect(await fetchLatestVersion({ fresh: true, fetchImpl: fake(200, { version: '2.1.280' }) })).toMatchObject({ version: '2.1.280', error: null })
  })
  it('HTTP error and a version-less body are values, never throws', async () => {
    expect((await fetchLatestVersion({ fresh: true, fetchImpl: fake(503, {}) })).version).toBeNull()
    expect((await fetchLatestVersion({ fresh: true, fetchImpl: fake(200, { version: 'latest' } ) })).version).toBeNull()
  })
})

class FakeChild extends EventEmitter { stderr = new EventEmitter(); kill() { /* no-op */ } }
function fakeSpawn(exitCode: number, stderr = '') {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const spawnImpl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const child = new FakeChild()
    setTimeout(() => { if (stderr) child.stderr.emit('data', Buffer.from(stderr)); child.emit('exit', exitCode) }, 5)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawnImpl, calls }
}
const waitDone = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 10)) }

describe('startCliUpdate (background job, one at a time, verified by the real probe, rule 4 note)', () => {
  it('npm path: install ok + probe ok -> done, carries the running-sessions note, measured version after', async () => {
    const { spawnImpl, calls } = fakeSpawn(0)
    const started = startCliUpdate('2.1.280', 'npm', { spawnImpl, probe: async () => ({ ok: true, exitCode: 1, signal: null, durationMs: 900 }), measure: async () => ({ version: '2.1.280' }), resolveBin: () => '/x/claude' })
    expect(started).toEqual({ ok: true })
    await waitDone(() => readCliUpdateResult()?.status !== 'running')
    expect(calls[0]).toEqual({ cmd: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code@2.1.280'] })
    expect(readCliUpdateResult()).toMatchObject({ status: 'done', target: '2.1.280', installedAfter: '2.1.280', note: RUNNING_SESSIONS_NOTE })
  })
  it('install ok but the new claude does not launch -> failed, says so', async () => {
    const { spawnImpl } = fakeSpawn(0)
    startCliUpdate('2.1.280', 'npm', { spawnImpl, probe: async () => ({ ok: false, exitCode: null, signal: 'TIMEOUT', durationMs: 25000 }), measure: async () => ({ version: '2.1.280' }), resolveBin: () => '/x/claude' })
    await waitDone(() => readCliUpdateResult()?.status !== 'running')
    expect(readCliUpdateResult()).toMatchObject({ status: 'failed' })
    expect(readCliUpdateResult()?.message).toContain('does not launch')
  })
  it('EACCES from npm -> failed with the sudo manual command; official path uses install.sh with the version', async () => {
    const { spawnImpl } = fakeSpawn(1, 'npm ERR! code EACCES')
    startCliUpdate('2.1.280', 'npm', { spawnImpl, probe: async () => ({ ok: true, exitCode: 1, signal: null, durationMs: 1 }), measure: async () => ({ version: null }), resolveBin: () => '/x/claude' })
    await waitDone(() => readCliUpdateResult()?.status !== 'running')
    expect(readCliUpdateResult()?.message).toContain('sudo npm install -g @anthropic-ai/claude-code@2.1.280')
    const off = fakeSpawn(0)
    startCliUpdate('2.1.112', 'official', { spawnImpl: off.spawnImpl, probe: async () => ({ ok: true, exitCode: 1, signal: null, durationMs: 1 }), measure: async () => ({ version: '2.1.112' }), resolveBin: () => '/x/claude' })
    await waitDone(() => readCliUpdateResult()?.status !== 'running')
    expect(off.calls[0].cmd).toBe('bash')
    expect(off.calls[0].args[1]).toContain("install.sh | bash -s '2.1.112'")
  })
  it('refuses a non-version target, an unknown method, and a second concurrent run', async () => {
    expect(startCliUpdate('latest', 'npm')).toMatchObject({ ok: false })
    expect(startCliUpdate('2.1.280', 'unknown')).toMatchObject({ ok: false })
    const slow = ((cmd: string, args: string[]) => { const c = new FakeChild(); setTimeout(() => c.emit('exit', 0), 300); return c }) as unknown as typeof import('node:child_process').spawn
    expect(startCliUpdate('2.1.280', 'npm', { spawnImpl: slow, probe: async () => ({ ok: true, exitCode: 1, signal: null, durationMs: 1 }), measure: async () => ({ version: '2.1.280' }), resolveBin: () => '/x/claude' })).toEqual({ ok: true })
    expect(startCliUpdate('2.1.280', 'npm', { spawnImpl: slow })).toMatchObject({ ok: false, error: expect.stringContaining('already running') })
    await waitDone(() => readCliUpdateResult()?.status !== 'running')
  })
})

describe('buildCliUpdateStatus + the routes', () => {
  afterEach(() => setCliUpdateDepsForTests(null))
  it('on an AVX-less host the registry is NOT consulted and the pin is the target', async () => {
    let latestCalls = 0
    const s = await buildCliUpdateStatus({
      measure: async () => ({ version: '2.1.110', error: null }),
      latest: async () => { latestCalls++; return { version: '2.1.280', error: null } },
      avxLess: () => true, pin: () => '2.1.112', resolveBin: () => '/usr/bin/claude',
    })
    expect(latestCalls).toBe(0)
    expect(s).toMatchObject({ avxLess: true, target: '2.1.112', targetKind: 'avx-safe-pin', offer: true, latest: null })
    expect(s.manualCommand).toContain('@2.1.112')
  })
  function fakeCtx(path: string, method: string, body = '') {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) }, setHeader() { /* noop */ } }
    const req = new EventEmitter() as any
    setTimeout(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end') }, 1)
    const url = new URL(`http://localhost:3420${path}`)
    const ctx = { req, res, path: url.pathname, method, url } as unknown as RouteContext
    return { ctx, out }
  }
  it('GET /api/updates/cli returns the offer; POST with a version the GET did not offer is 409, a non-version is 400', async () => {
    setCliUpdateDepsForTests({
      measure: async () => ({ version: '2.1.278', error: null }),
      latest: async () => ({ version: '2.1.280', error: null }),
      avxLess: () => false, pin: () => '2.1.112', resolveBin: () => '/opt/weird/claude',
    })
    const g = fakeCtx('/api/updates/cli', 'GET')
    expect(await tryHandleUpdates(g.ctx)).toBe(true)
    expect(g.out.status === 0 || g.out.status === 200).toBe(true)
    expect(g.out.body).toMatchObject({ installed: '2.1.278', latest: '2.1.280', target: '2.1.280', offer: true })
    const bad = fakeCtx('/api/updates/cli/apply', 'POST', JSON.stringify({ target: 'latest' }))
    await tryHandleUpdates(bad.ctx)
    expect(bad.out.status).toBe(400)
    const other = fakeCtx('/api/updates/cli/apply', 'POST', JSON.stringify({ target: '2.1.279' }))
    await tryHandleUpdates(other.ctx)
    expect(other.out.status).toBe(409)
    // the offered target, but the binary's install method is unknown -> 400 with the manual command, nothing spawned
    const unk = fakeCtx('/api/updates/cli/apply', 'POST', JSON.stringify({ target: '2.1.280' }))
    await tryHandleUpdates(unk.ctx)
    expect(unk.out.status).toBe(400)
    expect(unk.out.body.manualCommand).toContain('@2.1.280')
  })
})

describe('the served client', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
  const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
  const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')
  it('has the offer box, posts only the offered target, and says that running sessions keep the old binary', () => {
    expect(html).toContain('id="updatesCli"')
    expect(app).toContain("fetch('/api/updates/cli'")
    expect(app).toContain("body: JSON.stringify({ target })")
    expect(app).toContain("t('updates.cli.sessions_note')")
    expect(app).toContain("t('updates.cli.confirm', { v: target })")
    for (const k of ['updates.cli.title', 'updates.cli.offer', 'updates.cli.btn', 'updates.cli.confirm', 'updates.cli.sessions_note', 'updates.cli.avx_note', 'updates.cli.done', 'updates.cli.failed']) {
      expect(hu, k).toContain(`'${k}'`)
      expect(en, k).toContain(`'${k}'`)
    }
  })
})
