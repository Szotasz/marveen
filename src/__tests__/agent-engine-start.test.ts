import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHANNEL_TOKEN_UNSET } from '../web/agent-engine.js'

const harness = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
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
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: vi.fn((file: string, args: readonly string[] = []) => {
    harness.calls.push({ file, args: [...args] })
    if (file === 'bash' && args[0] === join(sandbox, 'scripts/codex-agent.sh')) {
      return `${harness.launcherOutput}\n`
    }
    return ''
  }),
}))
vi.mock('../platform.js', async original => ({
  ...await original<typeof import('../platform.js')>(),
  makeLazyBinResolver: (name: string) => () => name,
}))
vi.mock('../web/agent-scaffold.js', () => ({ scaffoldAgentDir: vi.fn() }))
vi.mock('../web/requeue-notice.js', () => ({ requeueAbandonedAndNotify: vi.fn() }))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(), notifyTelegram: vi.fn() }))

const agentConfig = await import('../web/agent-config.js')
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
    expect(launcherCalls()).toEqual([{ file: 'bash', args: [join(sandbox, 'scripts/codex-agent.sh'), codexConfigDir, dir] }])
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
    expect(launcherCalls()).toEqual([{ file: 'bash', args: [join(sandbox, 'scripts/codex-agent.sh'), codexConfigDir, dir, join(dir, '.codex-overrides')] }])
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

  it('starts a codexSandbox=relay agent only once the real relay daemon is ready', async () => {
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
    const readyMarker = join(dir, '.dashboard-relay', 'relay.ready')
    try {
      expect(await startAgentProcess(name)).toEqual({ ok: true })
      // The start reported ok only after the ready marker named the spawned
      // pid, and the launcher ran strictly after that: the fail-closed ordering
      // the relay profile exists for.
      expect(existsSync(readyMarker)).toBe(true)
      expect(launcherCalls().length).toBeGreaterThanOrEqual(1)
    } finally {
      // Before the assertions that can throw and before the next beforeEach
      // wipes this dir: a leaked daemon would outlive its relay dir.
      await stopDashboardRelay(dir)
    }
    // SIGTERM makes the daemon unlink its own marker; give that unlink a moment.
    const deadline = Date.now() + 5000
    while (existsSync(readyMarker) && Date.now() < deadline) await sleep(50)
    expect(existsSync(readyMarker)).toBe(false)
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
