import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { CHANNEL_TOKEN_UNSET } from '../web/agent-engine.js'

const harness = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[]; env?: NodeJS.ProcessEnv }[],
  launcherError: null as Error | null,
  tmuxError: null as Error | null,
  // command is the expected tmux command; launcherOutput is the unsanitized launcher result.
  command: 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR && export CODEX_HOME=/x && exec codex',
  launcherOutput: 'export CODEX_HOME=/x && exec codex',
}))
const sandbox = mkdtempSync(join(tmpdir(), 'agent-engine-start-'))
const launcher = resolve('scripts/codex-agent.sh')
// Getters, not values: agent-engine.ts now imports config.js statically, so
// this factory can run before the module body initializes `sandbox` above --
// evaluating it lazily keeps every consumer reading it at call time.
vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(),
  get PROJECT_ROOT() { return sandbox },
  get STORE_DIR() { return join(sandbox, 'store') },
  CHANNEL_PROVIDER: 'telegram',
}))
vi.mock('node:child_process', async original => {
  const childProcess = await original<typeof import('node:child_process')>()
  return {
    ...childProcess,
    execFileSync: vi.fn((file: string, args: readonly string[] = [], options?: { env?: NodeJS.ProcessEnv }) => {
      harness.calls.push({ file, args: [...args], ...(options?.env ? { env: { ...options.env } } : {}) })
      if (file === 'ps') return spawnSync(file, [...args], { encoding: 'utf-8' }).stdout
      if (file === 'bash' && args[0] === join(sandbox, 'scripts/codex-agent.sh')) {
        if (harness.launcherError) throw harness.launcherError
        return `${harness.launcherOutput}\n`
      }
      if (file === 'tmux' && args.includes('new-session') && harness.tmuxError) throw harness.tmuxError
      return ''
    }),
    spawn: vi.fn((file: string, args: readonly string[] = [], options?: import('node:child_process').SpawnOptions) => {
      harness.calls.push({ file, args: [...args] })
      return childProcess.spawn(file, args, options ?? {})
    }),
  }
})
vi.mock('../platform.js', async original => ({
  ...await original<typeof import('../platform.js')>(),
  makeLazyBinResolver: (name: string) => () => name,
}))
vi.mock('../web/agent-scaffold.js', () => ({ scaffoldAgentDir: vi.fn() }))
vi.mock('../web/requeue-notice.js', () => ({ requeueAbandonedAndNotify: vi.fn() }))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(), notifyTelegram: vi.fn() }))

const agentConfig = await import('../web/agent-config.js')
const { dashboardTokenPathFor } = await import('../web/agent-tokens.js')
const { startAgentProcess, stopDashboardRelay } = await import('../web/agent-process.js')
const name = 'codex-pilot'
const dir = agentConfig.agentDir(name)
const codexConfigDir = join(sandbox, 'codex-home')
const launcherCalls = () => harness.calls.filter(call => call.file === 'bash' && call.args[0] === join(sandbox, 'scripts/codex-agent.sh'))
const sessionCalls = () => harness.calls.filter(call => call.file === 'tmux' && call.args.includes('new-session'))
const sleep = (ms: number) => new Promise<void>(timer => setTimeout(timer, ms))

beforeEach(() => {
  vi.restoreAllMocks()
  harness.calls.length = 0
  harness.launcherError = null
  harness.tmuxError = null
  vi.mocked(spawn).mockClear()
  rmSync(join(sandbox, 'store', 'codex-relay'), { recursive: true, force: true })
  rmSync(join(sandbox, 'spool-victim'), { recursive: true, force: true })
  rmSync(join(sandbox, 'agents'), { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
    // Explicit full-access: these tests pin the launcher dispatch, not the relay daemon (its own test is below).
    engine: 'codex', codexConfigDir, codexSandbox: 'full-access',
    // Codex must dispatch before Claude-only authentication is considered.
    oauthTokenFile: 'relative-token',
  }))
})
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

describe('Codex agent start behaviour', () => {
  it('--run removes all Claude and Anthropic environment variables before executing the binary', () => {
    const temp = mkdtempSync(join(tmpdir(), 'codex-run-'))
    try {
      const stub = join(temp, 'print-env.sh')
      writeFileSync(stub, '#!/bin/sh\nenv\n', { mode: 0o700 })
      const result = spawnSync('bash', [launcher, '--run', stub], {
        encoding: 'utf-8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: '/x',
          ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'x', KEEP_ME: '1',
        },
      })
      expect(result.status).toBe(0)
      expect(result.stdout.split('\n')).toContain('KEEP_ME=1')
      expect(result.stdout).not.toMatch(/^(CLAUDE|ANTHROPIC)/m)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('dispatches a Codex agent to the Codex launcher and tmux command before the Claude path', async () => {
    expect(await startAgentProcess(name)).toEqual({ ok: true })
    expect(launcherCalls()).toEqual([{ file: 'bash', args: [join(sandbox, 'scripts/codex-agent.sh'), codexConfigDir, dir], env: expect.objectContaining({ MARVEEN_CODEX_SANDBOX: 'full-access' }) }])
    expect(sessionCalls()).toHaveLength(1)
    expect(sessionCalls()[0].args).toEqual(['new-session', '-d', '-s', `agent-${name}`, harness.command])
    for (const call of harness.calls) {
      // The sandbox lives under the OS temp dir, whose path may itself contain "claude".
      expect([call.file, ...call.args].join('\n').replaceAll(sandbox, '<sandbox>')).not.toMatch(/claude|CLAUDE_CODE_OAUTH_TOKEN/i)
    }
  })

  it('passes the agent overrides file as a third launcher argument for codexIdentity=overrides', async () => {
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexIdentity: 'overrides', codexSandbox: 'full-access',
      oauthTokenFile: 'relative-token',
    }))
    expect(await startAgentProcess(name)).toEqual({ ok: true })
    expect(launcherCalls()).toEqual([{ file: 'bash', args: [join(sandbox, 'scripts/codex-agent.sh'), codexConfigDir, dir, join(dir, '.codex-overrides')], env: expect.objectContaining({ MARVEEN_CODEX_SANDBOX: 'full-access' }) }])
    expect(sessionCalls()).toHaveLength(1)
  })

  it('refuses a Codex agent that owns a channel binding before launching anything', async () => {
    const channelDir = join(dir, '.claude', 'channels', 'telegram')
    mkdirSync(channelDir, { recursive: true })
    writeFileSync(join(channelDir, '.env'), 'TELEGRAM_BOT_TOKEN=fixture-token\n')
    // Config validation also rejects bindings. Bypass that redundant check so
    // this test pins the start-time channel guard and the real channel lookup.
    vi.spyOn(agentConfig, 'validateAgentEngineConfig').mockReturnValueOnce({ engine: 'codex', codexConfigDir, codexIdentity: 'seat', codexSandbox: 'full-access' })
    expect(await startAgentProcess(name)).toEqual({ ok: false, error: 'Codex agents cannot own channel bindings' })
    expect(launcherCalls()).toHaveLength(0)
    expect(sessionCalls()).toHaveLength(0)
  })

  it.each([false, true])('B4-version B1 B2 composes before starting the daemon with private files (existing dirs: %s)', async existing => {
    // startDashboardRelayDaemon spawns PROJECT_ROOT/scripts/codex-relay/relay.mjs
    // and PROJECT_ROOT is this suite's sandbox, so stage the real daemon script
    // there: the spawn must be the REAL internal one, not another harness fake.
    // relay.mjs imports only node builtins, so a copy stands on its own, and it
    // reads its token lazily per request -- nothing under store/agent-tokens is
    // created and no network is touched by a start that ships no request files.
    mkdirSync(join(sandbox, 'scripts', 'codex-relay'), { recursive: true })
    copyFileSync(resolve('scripts/codex-relay/relay.mjs'), join(sandbox, 'scripts', 'codex-relay', 'relay.mjs'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexIdentity: 'seat', codexSandbox: 'relay',
    }))
    const relayDir = join(sandbox, 'store', 'codex-relay', name)
    const readyMarker = join(relayDir, 'relay.ready')
    const gitignore = join(dir, '.gitignore')
    if (existing) {
      for (const path of [relayDir, join(relayDir, 'requests'), join(relayDir, 'responses')]) {
        mkdirSync(path, { recursive: true })
        chmodSync(path, 0o755)
      }
      writeFileSync(gitignore, 'keep-this-exactly')
      const victim = join(sandbox, 'pid-victim')
      writeFileSync(victim, 'keep-pid-victim')
      symlinkSync(victim, join(relayDir, 'relay.pid'))
    }
    try {
      expect(await startAgentProcess(name)).toEqual({ ok: true })
      // Compose validates first; readiness is still required before tmux starts.
      const composeIndex = harness.calls.indexOf(launcherCalls()[0])
      const daemonIndex = harness.calls.findIndex(call => call.args[0] === join(sandbox, 'scripts', 'codex-relay', 'relay.mjs'))
      expect(composeIndex).toBeGreaterThanOrEqual(0)
      expect(daemonIndex).toBeGreaterThan(composeIndex)
      const daemonArgs = harness.calls[daemonIndex].args
      const tokenIndex = daemonArgs.indexOf('--token-file')
      expect(tokenIndex).toBeGreaterThanOrEqual(0)
      expect(daemonArgs.slice(tokenIndex, tokenIndex + 2)).toEqual(['--token-file', dashboardTokenPathFor(name)])
      expect(existsSync(join(sandbox, 'store', 'agent-tokens'))).toBe(false)
      expect(harness.calls.indexOf(sessionCalls()[0])).toBeGreaterThan(daemonIndex)
      expect(launcherCalls()[0].env?.MARVEEN_CODEX_SANDBOX).toBe('relay')
      expect(existsSync(readyMarker)).toBe(true)
      for (const path of [relayDir, join(relayDir, 'requests'), join(relayDir, 'responses')]) {
        expect(statSync(path).mode & 0o777).toBe(0o700)
      }
      if (!existing) expect(statSync(join(sandbox, 'store', 'codex-relay')).mode & 0o777).toBe(0o700)
      for (const file of ['relay.log', 'relay.pid']) {
        expect(statSync(join(relayDir, file)).mode & 0o777).toBe(0o600)
        expect(existsSync(join(dir, file))).toBe(false)
      }
      expect(readFileSync(join(relayDir, 'relay.pid'), 'utf-8')).toBe(readFileSync(readyMarker, 'utf-8'))
      expect(existsSync(join(dir, '.dashboard-relay'))).toBe(false)
      if (existing) {
        expect(readFileSync(gitignore, 'utf-8')).toBe('keep-this-exactly')
        expect(readFileSync(join(sandbox, 'pid-victim'), 'utf-8')).toBe('keep-pid-victim')
      } else expect(existsSync(gitignore)).toBe(false)
      expect(launcherCalls().length).toBeGreaterThanOrEqual(1)
    } finally {
      // Before the assertions that can throw and before the next beforeEach
      // wipes this dir: a leaked daemon would outlive its relay dir.
      await stopDashboardRelay(name)
    }
    // SIGTERM makes the daemon unlink its own marker; give that unlink a moment.
    const deadline = Date.now() + 5000
    while (existsSync(readyMarker) && Date.now() < deadline) await sleep(50)
    expect(existsSync(readyMarker)).toBe(false)
  })

  it('a start stops a relay daemon left over from a previous life', async () => {
    mkdirSync(join(sandbox, 'scripts', 'codex-relay'), { recursive: true })
    copyFileSync(resolve('scripts/codex-relay/relay.mjs'), join(sandbox, 'scripts', 'codex-relay', 'relay.mjs'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    const relayDir = join(sandbox, 'store', 'codex-relay', name)
    try {
      expect(await startAgentProcess(name)).toEqual({ ok: true })
      const oldPid = Number(readFileSync(join(relayDir, 'relay.pid'), 'utf-8'))
      expect(() => process.kill(oldPid, 0)).not.toThrow()
      expect(await startAgentProcess(name)).toEqual({ ok: true })
      const alive = () => {
        try { process.kill(oldPid, 0); return true } catch { return false }
      }
      const deadline = Date.now() + 5000
      while (alive() && Date.now() < deadline) await sleep(50)
      expect(alive()).toBe(false)
      const newPid = Number(readFileSync(join(relayDir, 'relay.pid'), 'utf-8'))
      expect(newPid).not.toBe(oldPid)
      expect(newPid).toBe(Number(readFileSync(join(relayDir, 'relay.ready'), 'utf-8')))
    } finally {
      await stopDashboardRelay(name)
    }
  }, 10_000)

  it('B2-cleanup stops the relay daemon when tmux new-session throws and preserves the tmux error', async () => {
    mkdirSync(join(sandbox, 'scripts', 'codex-relay'), { recursive: true })
    copyFileSync(resolve('scripts/codex-relay/relay.mjs'), join(sandbox, 'scripts', 'codex-relay', 'relay.mjs'))
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    harness.tmuxError = new Error('tmux new-session failed')
    const relayDir = join(sandbox, 'store', 'codex-relay', name)
    try {
      expect(await startAgentProcess(name)).toEqual({ ok: false, error: harness.tmuxError.message })
      expect(sessionCalls()).toHaveLength(1)
      expect(spawn).toHaveBeenCalledTimes(1)
      const child = vi.mocked(spawn).mock.results[0].value as import('node:child_process').ChildProcess
      expect(child.pid).toBeGreaterThan(0)
      expect(() => process.kill(child.pid!, 0)).toThrow()
      expect(existsSync(join(relayDir, 'relay.pid'))).toBe(false)
      // Same shutdown marker observation as the successful-start relay test.
      const deadline = Date.now() + 5000
      while (existsSync(join(relayDir, 'relay.ready')) && Date.now() < deadline) await sleep(50)
      expect(existsSync(join(relayDir, 'relay.ready'))).toBe(false)
    } finally {
      // A failing regression assertion must not leak the real daemon.
      await stopDashboardRelay(name)
    }
  })

  it('B2-cleanup never attempts relay stop for a full-access agent when tmux throws', async () => {
    const relayDir = join(sandbox, 'store', 'codex-relay', name)
    mkdirSync(relayDir, { recursive: true })
    const pidPath = join(relayDir, 'relay.pid')
    // stopDashboardRelay would discard this file even without a running daemon.
    writeFileSync(pidPath, 'not-a-relay-pid')
    harness.tmuxError = new Error('full-access tmux new-session failed')
    expect(await startAgentProcess(name)).toEqual({ ok: false, error: harness.tmuxError.message })
    expect(sessionCalls()).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(readFileSync(pidPath, 'utf-8')).toBe('not-a-relay-pid')
  })

  it('B2 refuses a pre-planted relay.log symlink before spawning or starting tmux', async () => {
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    const relayDir = join(sandbox, 'store', 'codex-relay', name)
    mkdirSync(relayDir, { recursive: true })
    const victim = join(sandbox, 'log-victim')
    writeFileSync(victim, 'keep-log-victim')
    symlinkSync(victim, join(relayDir, 'relay.log'))
    const result = await startAgentProcess(name)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/ELOOP|symbolic link/i)
    expect(readFileSync(victim, 'utf-8')).toBe('keep-log-victim')
    expect(existsSync(join(relayDir, 'relay.pid'))).toBe(false)
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
    expect(launcherCalls()).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(sessionCalls()).toHaveLength(0)
  })

  it('R1-spool refuses a symlinked store/codex-relay before writing through it', async () => {
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    const victim = join(sandbox, 'spool-victim')
    mkdirSync(victim)
    mkdirSync(join(sandbox, 'store'), { recursive: true })
    symlinkSync(victim, join(sandbox, 'store', 'codex-relay'))
    const result = await startAgentProcess(name)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/relay spool path is a symlink/)
    expect(readdirSync(victim)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(sessionCalls()).toHaveLength(0)
  })

  it('R1-spool refuses a symlinked relay dir before writing through it', async () => {
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    const victim = join(sandbox, 'spool-victim')
    mkdirSync(victim)
    mkdirSync(join(sandbox, 'store', 'codex-relay'), { recursive: true })
    symlinkSync(victim, join(sandbox, 'store', 'codex-relay', name))
    const result = await startAgentProcess(name)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/relay spool path is a symlink/)
    expect(readdirSync(victim)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(sessionCalls()).toHaveLength(0)
  })

  it('R1-spool refuses a symlinked requests dir before writing through it', async () => {
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    const victim = join(sandbox, 'spool-victim')
    mkdirSync(victim)
    const relayDir = join(sandbox, 'store', 'codex-relay', name)
    mkdirSync(relayDir, { recursive: true })
    symlinkSync(victim, join(relayDir, 'requests'))
    const result = await startAgentProcess(name)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/relay spool path is a symlink/)
    expect(readdirSync(victim)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    expect(sessionCalls()).toHaveLength(0)
  })

  it('B4-version launcher failure starts neither relay nor tmux', async () => {
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir, codexSandbox: 'relay',
    }))
    harness.launcherError = new Error('launcher requires codex >= 0.163.0 (found 0.162.9)')
    expect(await startAgentProcess(name)).toEqual({ ok: false, error: harness.launcherError.message })
    expect(launcherCalls()).toHaveLength(1)
    expect(launcherCalls()[0].env?.MARVEEN_CODEX_SANDBOX).toBe('relay')
    expect(spawn).not.toHaveBeenCalled()
    expect(existsSync(join(sandbox, 'store', 'codex-relay', name))).toBe(false)
    expect(sessionCalls()).toHaveLength(0)
  })

  it('B4-version full-access overrides an inherited relay environment', async () => {
    const previous = process.env.MARVEEN_CODEX_SANDBOX
    process.env.MARVEEN_CODEX_SANDBOX = 'relay'
    try {
      expect(await startAgentProcess(name)).toEqual({ ok: true })
      expect(launcherCalls()[0].env?.MARVEEN_CODEX_SANDBOX).toBe('full-access')
      expect(process.env.MARVEEN_CODEX_SANDBOX).toBe('relay')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.MARVEEN_CODEX_SANDBOX
      else process.env.MARVEEN_CODEX_SANDBOX = previous
    }
  })
})

it('T7 prefixes the exact Codex tmux command and really scrubs inherited channel tokens', async () => {
  expect(await startAgentProcess(name)).toEqual({ ok: true })
  expect(sessionCalls()).toHaveLength(1)
  expect(sessionCalls()[0].args.at(-1)).toBe(`${CHANNEL_TOKEN_UNSET} && ${harness.launcherOutput}`)
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: 'dummy' }
  const control = spawnSync('bash', ['-c', 'env'], { env, encoding: 'utf-8' })
  expect(control.status).toBe(0)
  expect(control.stdout).toContain('TELEGRAM_BOT_TOKEN=dummy')
  const scrubbed = spawnSync('bash', ['-c', `${CHANNEL_TOKEN_UNSET} && env`], { env, encoding: 'utf-8' })
  expect(scrubbed.status).toBe(0)
  expect(scrubbed.stdout).not.toContain('TELEGRAM_BOT_TOKEN=')
})
