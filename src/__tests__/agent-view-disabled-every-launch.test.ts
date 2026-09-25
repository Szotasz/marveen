import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'
import { buildRemoteLaunchCommand } from '../web/ssh-tmux.js'

// CHANSPARE925 (measured 2026-09-25): the Agent view's "← for agents" key moves a
// running session into the Claude Code daemon as a background worker, and the daemon
// keeps it -- and a prewarmed spare -- alive with the SAME --channels flag. That
// second copy of the channel plugin took the main agent's bot poller; the owner's
// messages went to a session with no transcript. CLAUDE_CODE_DISABLE_AGENT_VIEW=1
// removes the key (no daemon, no claim), while run_in_background, Monitor and the
// Agent tool (foreground and background subagents) keep working -- measured in an
// isolated config dir. One launch path without it leaves the same hole open, so
// every path is pinned here, and a new path that launches claude without it fails
// the enumeration below first.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FLAG = 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1'

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

describe('every fleet launch path disables the Agent view', () => {
  it('channels.sh: exported for the main session, in the sub-agent MCP env, and in the tmux global env', () => {
    const s = read('scripts/channels.sh')
    expect(s).toMatch(/^export CLAUDE_CODE_DISABLE_AGENT_VIEW=1$/m)
    expect(s).toMatch(/^MCP_BATCH_ENV="export [^"]*CLAUDE_CODE_DISABLE_AGENT_VIEW=1 /m)
    expect(s).toMatch(/\$TMUX set-environment -g CLAUDE_CODE_DISABLE_AGENT_VIEW 1/)
  })

  it('channel-watchdog.sh respawn command', () => {
    expect(read('scripts/channel-watchdog.sh')).toMatch(/^RESPAWN_CMD="[^\n]*CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && [^\n]*--dangerously-skip-permissions/m)
  })

  it('stuck-modal-guard.sh respawn command', () => {
    expect(read('scripts/stuck-modal-guard.sh')).toMatch(/local RESPAWN_CMD="[^\n]*export CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && [^\n]*--dangerously-skip-permissions/)
  })

  it('watchdog.sh sub-agent relaunch', () => {
    expect(read('scripts/watchdog.sh')).toMatch(/CMD="\$\{ISO_ENV\}[^\n]*export CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && [^\n]*--dangerously-skip-permissions/)
  })

  it('morning-briefing.sh (print mode, same flag set)', () => {
    expect(read('scripts/morning-briefing.sh')).toMatch(/^CLAUDE_CODE_DISABLE_AGENT_VIEW=1 \$CLAUDE --dangerously-skip-permissions/m)
  })

  it('agent-process.ts sub-agent launch env', () => {
    expect(read('src/web/agent-process.ts')).toMatch(/'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && '/)
  })

  it('agent-worker.ts worker launch', () => {
    expect(read('src/web/agent-worker.ts')).toMatch(/`export CLAUDE_CODE_DISABLE_AGENT_VIEW=1; ` \+/)
  })

  it('channel-monitor main respawn command carries it before claude (behaviour)', () => {
    const cmd = buildMainSessionRespawnCmd({
      claudePath: '/usr/local/bin/claude',
      pluginId: 'telegram@claude-plugins-official',
      model: 'claude-opus-4-8[1m]',
      config: mainConfigDecisionForTest(),
      channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/marveen/.claude/channels/telegram' },
      continueSession: false,
    })
    expect(cmd).toContain(`export ${FLAG}`)
    expect(cmd.indexOf(FLAG)).toBeLessThan(cmd.indexOf('/usr/local/bin/claude'))
  })

  it('ssh-tmux remote launch carries it before claude (behaviour)', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/x/agents/a', model: 'claude-opus-4-8', continue: false })
    expect(cmd).toContain(`export ${FLAG}`)
    expect(cmd.indexOf(FLAG)).toBeLessThan(cmd.indexOf(' claude '))
  })
})

// Every code line (not a comment) in scripts/*.sh and src/**/*.ts that launches
// claude with --dangerously-skip-permissions must sit in a file that carries the
// flag. A new launch path added without it fails here before it can ship.
function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') yield* walk(p) } else yield p
  }
}

describe('no launch path is missing the flag (enumeration)', () => {
  it('each file with a --dangerously-skip-permissions launch line also carries CLAUDE_CODE_DISABLE_AGENT_VIEW=1', () => {
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
      if (!code.some((l) => l.includes('CLAUDE_CODE_DISABLE_AGENT_VIEW'))) missing.push(relative(ROOT, f))
    }
    expect(launchers.length).toBeGreaterThanOrEqual(8)
    expect(missing).toEqual([])
  })
})
