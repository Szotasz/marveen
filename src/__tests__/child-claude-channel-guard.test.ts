// CHILDCLAUDEPOLLER1010 -- the guard that stops a channel-owning session from
// starting a child `claude` with the inherited channel state.
//
// The failure it prevents was measured 2026-10-10: three `claude -p` calls from
// a live sub-agent's Bash each loaded the Telegram plugin, whose bot.pid logic
// SIGTERMed the parent's live poller ("replacing stale poller pid=<N>"). The
// parent's channel stayed dead until the session restarted, and nothing in the
// command's own output said so. See docs/mcp-list-channel-plugin.md.
//
// Driven two ways, like the sibling egress tests: the exported decision
// function, and the real hook process fed a PreToolUse payload on stdin.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { decide, inspectSegment, sessionOwnsChannel } from '../../scripts/hooks/child-claude-channel-guard.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = join(__dirname, '..', '..', 'scripts', 'hooks', 'child-claude-channel-guard.mjs')
const SCAFFOLD = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
const WEB = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')

// The sub-agent launcher exports all three at once, so the tests do too.
const CHANNEL_ENV = { TELEGRAM_STATE_DIR: '/x/tg', DISCORD_STATE_DIR: '/x/dc', SLACK_STATE_DIR: '/x/sl' }
const ISOLATED = 'env -u TELEGRAM_STATE_DIR -u DISCORD_STATE_DIR -u SLACK_STATE_DIR CLAUDE_CONFIG_DIR=/x/empty'

describe('child-claude guard: what it blocks', () => {
  it.each([
    ['claude -p "hi"'],
    ['claude mcp list'],
    ['cd /work && claude -p "ok"'],
    ['/Users/someone/.local/bin/claude -p x'],
    ['CLAUDE_CONFIG_DIR=/x/empty claude -p x'], // own config dir, but the state dir is still inherited
    ['env -u TELEGRAM_STATE_DIR CLAUDE_CONFIG_DIR=/x/empty claude -p x'], // DISCORD/SLACK still inherited
    ['nohup claude -p x &'],
    ['echo start; claude --model haiku -p x'],
  ])('denies %s in a channel-owning session', (command) => {
    expect(decide(command, CHANNEL_ENV).allow).toBe(false)
  })
})

describe('child-claude guard: what it leaves alone', () => {
  it.each([
    [`${ISOLATED} claude -p x`],
    ['env -i PATH=/usr/bin HOME=/x claude -p x'],
    ['claude --version'],
    ['claude --help'],
    ['claude install latest'],
    ['grep claude -p notes.txt'], // `claude` is an argument, not the command
    ['echo "claude -p"'],
    ['ls ~/.claude/skills'],
    ['cat claude-code-install-watch.md'],
  ])('allows %s', (command) => {
    expect(decide(command, CHANNEL_ENV).allow).toBe(true)
  })

  // Measured 2026-10-10 on the first live version: a python heredoc that only
  // DOCUMENTED the guard was blocked, because a backtick inside the heredoc text
  // started a new segment. Inert text must not count as a command.
  it.each([
    ["python3 - <<'PY'\nprint('a plain child `claude` does')\nPY\n"],
    ['cat > note.md <<EOF\nclaude -p hi\nEOF'],
    ['git commit -m "docs: never run claude -p from a channel session"'],
    ["echo 'x; claude -p'"],
  ])('allows inert text that only mentions claude: %s', (command) => {
    expect(decide(command, CHANNEL_ENV).allow).toBe(true)
  })

  it('still sees a real invocation after a heredoc ends', () => {
    expect(decide('cat > f <<EOF\nhi\nEOF\nclaude -p x', CHANNEL_ENV).allow).toBe(false)
  })

  it('does nothing in a session without a channel state dir', () => {
    expect(sessionOwnsChannel({})).toBe(false)
    expect(decide('claude -p x', {}).allow).toBe(true)
  })

  it('treats an empty state variable as absent', () => {
    expect(sessionOwnsChannel({ TELEGRAM_STATE_DIR: '' })).toBe(false)
  })

  it('reads the environment changes of the segment, not of the whole command', () => {
    const hit = inspectSegment(' env -u TELEGRAM_STATE_DIR CLAUDE_CONFIG_DIR=/e claude -p x')
    expect(hit.setsConfigDir).toBe(true)
    expect([...hit.neutralised]).toEqual(['TELEGRAM_STATE_DIR'])
    expect(inspectSegment('git status')).toBeNull()
  })
})

describe('child-claude guard: the real hook process', () => {
  const run = (command: string, env: Record<string, string>) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  })

  it('emits a deny decision with the reason and the safe pattern', () => {
    const r = run('claude -p "hi"', CHANNEL_ENV)
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/replacing stale poller/)
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/CLAUDE_CONFIG_DIR=/)
  })

  it('stays silent (allow) for an isolated child', () => {
    const r = run(`${ISOLATED} claude -p x`, CHANNEL_ENV)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('fails open on a payload it cannot parse', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', env: CHANNEL_ENV, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('child-claude guard: where it lands', () => {
  it('is injected on spawn for sub-agents', () => {
    expect(SCAFFOLD).toContain('if (agentGetsChildClaudeGuard(name)) injectChildClaudeGuard(existing)')
  })

  it('is backfilled into the existing fleet at startup', () => {
    expect(WEB).toContain('if (ensureChildClaudeGuard(agentName)) childGuardPatched.push(agentName)')
  })

  it('exempts the main agent, like the outgoing-copy gate', () => {
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function agentGetsChildClaudeGuard('))
    expect(fn.slice(0, 200)).toMatch(/return name !== MAIN_AGENT_ID/)
  })
})
