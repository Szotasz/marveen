import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT_SANDBOX_ENV } from '../web/root-sandbox-env.js'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'
import { buildRemoteLaunchCommand } from '../web/ssh-tmux.js'

// ROOTRESPAWN1001 (customer report 2026-10-01, measured in a root container on
// claude 2.1.287): as uid 0, `claude --dangerously-skip-permissions` exits 1 with
// "cannot be used with root/sudo privileges for security reasons" unless
// IS_SANDBOX=1. A tmux pane gets the SERVER's environment, not the calling
// client's, so an export in channels.sh reached the pane only when channels.sh
// created the server. Every launch path now carries the guard in its own command.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

// Run a command string in bash with `id -u` stubbed to `uid`. A function shadows
// the binary inside $( ) as well, so this exercises the guard as the pane runs it.
function runAs(uid: number, cmd: string): string {
  return execFileSync('bash', ['-c', `id() { echo ${uid}; }\n${cmd}`], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
  })
}

describe('the guard itself (behaviour)', () => {
  it('root: exports IS_SANDBOX=1 and lets the chain continue', () => {
    expect(runAs(0, `${ROOT_SANDBOX_ENV} && echo "chain:\${IS_SANDBOX:-unset}"`).trim()).toBe('chain:1')
  })
  it('non-root: leaves IS_SANDBOX unset and still lets the chain continue', () => {
    expect(runAs(501, `${ROOT_SANDBOX_ENV} && echo "chain:\${IS_SANDBOX:-unset}"`).trim()).toBe('chain:unset')
  })
})

describe('the main-session recovery respawn (behaviour)', () => {
  // claudePath is a stand-in that prints what claude would see.
  const dir = mkdtempSync(join(tmpdir(), 'rootresp-'))
  const fake = join(dir, 'claude')
  writeFileSync(fake, '#!/bin/sh\necho "claude-sees:${IS_SANDBOX:-unset}"\n')
  chmodSync(fake, 0o755)
  const cmd = buildMainSessionRespawnCmd({
    claudePath: fake,
    pluginId: 'telegram@claude-plugins-official',
    model: 'claude-opus-5-5',
    config: mainConfigDecisionForTest(),
    channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: join(dir, 'state') },
    continueSession: false,
  })
  it('as root, the claude it launches sees IS_SANDBOX=1', () => {
    expect(runAs(0, cmd)).toContain('claude-sees:1')
  })
  it('as a normal user, nothing changes', () => {
    expect(runAs(501, cmd)).toContain('claude-sees:unset')
  })
  it('cleanup', () => { rmSync(dir, { recursive: true, force: true }) })
})

describe('every other launch path carries the guard before claude', () => {
  it('ssh-tmux remote launch (evaluated on the remote host)', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/x/agents/a', model: 'm', continue: false })
    expect(cmd).toContain(ROOT_SANDBOX_ENV)
    expect(cmd.indexOf(ROOT_SANDBOX_ENV)).toBeLessThan(cmd.indexOf(' claude '))
  })

  it('agent-process.ts sub-agent launch and agent-worker.ts worker launch', () => {
    expect(read('src/web/agent-process.ts')).toMatch(/CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && ' \+\n\s*\/\/[^\n]*\n\s*`\$\{ROOT_SANDBOX_ENV\} && `/)
    expect(read('src/web/agent-worker.ts')).toMatch(/`\$\{ROOT_SANDBOX_ENV\}; ` \+/)
  })

  // The shell scripts build the pane command in a double-quoted string, so the
  // escaping is what decides whether the PANE evaluates the uid. Expand each
  // assignment in bash and compare with the TS constant, character for character.
  const expand = (line: string, varName: string) =>
    execFileSync('bash', ['-c', `${line.trim().replace(/^local /, '')}\nprintf '%s' "$${varName}"`], { encoding: 'utf-8' })
  const lineOf = (rel: string, re: RegExp) => {
    const l = read(rel).split('\n').find((x) => re.test(x))
    expect(l, `${rel}: ${re}`).toBeDefined()
    return l as string
  }
  it.each([
    ['scripts/channel-watchdog.sh', /^RESPAWN_CMD="/, 'RESPAWN_CMD'],
    ['scripts/stuck-modal-guard.sh', /^\s*local RESPAWN_CMD="/, 'RESPAWN_CMD'],
    ['scripts/watchdog.sh', /^\s*CMD="\$\{ISO_ENV\}/, 'CMD'],
    ['scripts/channels.sh', /^MCP_BATCH_ENV="/, 'MCP_BATCH_ENV'],
  ])('%s expands to the exact guard', (rel, re, v) => {
    expect(expand(lineOf(rel, re), v)).toContain(`${ROOT_SANDBOX_ENV} && `)
  })

  it('channels.sh puts IS_SANDBOX into the tmux server global env on a root host', () => {
    expect(read('scripts/channels.sh')).toMatch(/if \[ "\$\(id -u\)" = "0" \]; then \$TMUX set-environment -g IS_SANDBOX 1 2>\/dev\/null \|\| true; fi/)
  })

  it('morning-briefing.sh (a direct process, not a pane) exports it on root before claude', () => {
    const s = read('scripts/morning-briefing.sh')
    const guard = s.indexOf('if [ "$(id -u)" = "0" ]; then export IS_SANDBOX=1; fi')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(s.indexOf('$CLAUDE --dangerously-skip-permissions'))
  })
})

// A new launch path added without the guard fails here before it can ship.
function* walk(d: string): Generator<string> {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') yield* walk(p) } else yield p
  }
}

describe('no launch path is missing IS_SANDBOX (enumeration)', () => {
  it('each file with a --dangerously-skip-permissions launch line also handles IS_SANDBOX', () => {
    const files = [
      ...readdirSync(join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => join(ROOT, 'scripts', f)),
      ...[...walk(join(ROOT, 'src'))].filter((f) => f.endsWith('.ts')),
    ]
    const launchers: string[] = []
    const missing: string[] = []
    for (const f of files) {
      const code = readFileSync(f, 'utf-8').split('\n')
        .filter((l) => { const t = l.trim(); return !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('*') })
      if (!code.some((l) => l.includes('--dangerously-skip-permissions'))) continue
      launchers.push(relative(ROOT, f))
      if (!code.some((l) => l.includes('IS_SANDBOX') || l.includes('ROOT_SANDBOX_ENV'))) missing.push(relative(ROOT, f))
    }
    expect(launchers.length).toBeGreaterThanOrEqual(8)
    expect(missing).toEqual([])
  })
})
