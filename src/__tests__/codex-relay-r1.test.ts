import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_RELAY_PERMISSION_PROFILE,
  assertCodexSeatConfigCompatible,
  preflightCodexHome,
  renderCodexConfig,
  scaffoldCodexHome,
} from '../web/agent-engine.js'

const RELAY_MJS = fileURLToPath(new URL('../../scripts/codex-relay/relay.mjs', import.meta.url))
const opts = { profile: 'relay' as const, agentName: 'r1-agent' }

const cleanup: string[] = []
afterEach(() => {
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'marveen-r1-'))
  cleanup.push(root)
  mkdirSync(join(root, '.git')) // stops the project-config walk here
  const ws = join(root, 'ws')
  mkdirSync(ws)
  return { root, ws }
}

describe('R1 relay.mjs root check', () => {
  it('refuses to start when the relay dir parent is a symlink', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-r1-root-'))
    cleanup.push(tmp)
    const agent = 'r1-agent'
    mkdirSync(join(tmp, 'real-root', agent), { recursive: true })
    symlinkSync(join(tmp, 'real-root'), join(tmp, 'link-root'))
    const tokenFile = join(tmp, 'agent.token')
    writeFileSync(tokenFile, 'tok\n')
    const child = spawn(process.execPath, [RELAY_MJS,
      '--agent', agent,
      '--relay-dir', join(tmp, 'link-root', agent),
      '--token-file', tokenFile,
      '--dashboard-url', 'http://127.0.0.1:9/',
      '--audit-log', join(tmp, 'audit.log'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', () => { /* drained */ })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      const code = await new Promise<number | null>(res => child.on('exit', c => res(c)))
      expect(code).not.toBe(0)
      expect(stderr).toContain('relay root is not a real directory (symlink)')
      expect(existsSync(join(tmp, 'real-root', agent, 'relay.ready'))).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  }, 30_000)
})

describe('R1 codexConfigDir outside the workspace', () => {
  it.each(['seat', 'overrides'] as const)('refuses a home inside the workspace (%s)', identity => {
    const { ws } = fixture()
    expect(() => preflightCodexHome(join(ws, '.codex-home'), ws, {}, identity, opts)).toThrow(/is inside the agent workspace/)
  })

  it('refuses the workspace itself', () => {
    const { ws } = fixture()
    expect(() => preflightCodexHome(ws, ws, {}, 'seat', opts)).toThrow(/is inside the agent workspace/)
  })

  it('refuses a deep, not yet created home', () => {
    const { ws } = fixture()
    expect(() => preflightCodexHome(join(ws, 'a', 'b', 'c'), ws, {}, 'seat', opts)).toThrow(/is inside the agent workspace/)
  })

  it('refuses a home reached through a symlink into the workspace', () => {
    const { root, ws } = fixture()
    mkdirSync(join(ws, 'inner'))
    symlinkSync(join(ws, 'inner'), join(root, 'outside-link'))
    expect(() => preflightCodexHome(join(root, 'outside-link', 'home'), ws, {}, 'seat', opts)).toThrow(/is inside the agent workspace/)
  })

  it('accepts a sibling whose name starts with the workspace name', () => {
    const { ws } = fixture()
    expect(() => preflightCodexHome(ws + '-home', ws, {}, 'seat', opts)).not.toThrow()
  })

  it('does not apply to the default profile', () => {
    const { ws } = fixture()
    expect(() => preflightCodexHome(join(ws, '.codex-home'), ws, {}, 'seat', { agentName: 'r1-agent' })).not.toThrow()
  })

  it('scaffold refuses and leaves nothing behind', () => {
    const { ws } = fixture()
    expect(() => scaffoldCodexHome(join(ws, '.codex-home'), ws, {}, 'seat', opts)).toThrow(/is inside the agent workspace/)
    expect(existsSync(join(ws, '.codex-home'))).toBe(false)
    expect(() => scaffoldCodexHome(join(ws, '.codex-home'), ws, {}, 'overrides', opts)).toThrow(/is inside the agent workspace/)
    expect(existsSync(join(ws, '.codex-overrides'))).toBe(false)
  })
})

describe('R1 seat config with TOML multi-line strings', () => {
  it.each(["'''", '"""'])('refuses %s', quote => {
    const { root, ws } = fixture()
    const rendered = renderCodexConfig(ws, {}, opts)
    const line = `default_permissions = "${CODEX_RELAY_PERMISSION_PROFILE}"`
    expect(rendered.includes(line + '\n')).toBe(true)
    const home = join(root, 'seat-home')
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), rendered.replace(line + '\n', `developer_instructions = ${quote}\n${line}\n${quote}\n`))
    expect(() => assertCodexSeatConfigCompatible(home, ws, 'seat', opts)).toThrow(/multi-line string/)
  })

  it('accepts the exact rendered config', () => {
    const { root, ws } = fixture()
    const home = join(root, 'seat-home')
    mkdirSync(home)
    writeFileSync(join(home, 'config.toml'), renderCodexConfig(ws, {}, opts))
    expect(() => assertCodexSeatConfigCompatible(home, ws, 'seat', opts)).not.toThrow()
  })
})
