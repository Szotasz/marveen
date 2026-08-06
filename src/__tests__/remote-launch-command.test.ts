import { describe, it, expect } from 'vitest'
import { buildRemoteLaunchCommand, classifyRunState, classifyRunStateFromExit, buildContinueProbeCommand } from '../web/ssh-tmux.js'
import { FLEET_EFFORT_LEVEL, EFFORT_LEVELS } from '../model-id.js'

describe('classifyRunStateFromExit (failed list-sessions probe)', () => {
  it('remote ssh transport failure (exit 255) is unreachable', () => {
    expect(classifyRunStateFromExit(255, true)).toBe('unreachable')
  })

  it('remote reachable but tmux has no server/session (exit 1) is stopped, NOT unreachable', () => {
    // The crux: a reachable laptop with no tmux server yet must be startable.
    expect(classifyRunStateFromExit(1, true)).toBe('stopped')
  })

  it('remote killed/timeout (no numeric status) is unreachable', () => {
    expect(classifyRunStateFromExit(null, true)).toBe('unreachable')
    expect(classifyRunStateFromExit(undefined, true)).toBe('unreachable')
  })

  it('local failures are always stopped (no tmux server)', () => {
    expect(classifyRunStateFromExit(1, false)).toBe('stopped')
    expect(classifyRunStateFromExit(255, false)).toBe('stopped')
    expect(classifyRunStateFromExit(null, false)).toBe('stopped')
  })
})

describe('buildContinueProbeCommand', () => {
  it('keeps $HOME OUTSIDE the single-quoted region so the remote shell expands it', () => {
    const cmd = buildContinueProbeCommand('/var/www/casino-common')
    // $HOME must be in a double-quoted (expandable) region, NOT single-quoted.
    expect(cmd).toContain('"$HOME/.claude/projects/"')
    expect(cmd).not.toContain("'$HOME")
    // The encoded (leading-dash) segment is single-quoted and concatenated, so
    // it forms one path word and is not parsed as a `test` flag.
    expect(cmd).toContain("'-var-www-casino-common'")
    expect(cmd.startsWith('test -d ')).toBe(true)
  })

  it('encodes an absolute workdir with the leading-dash scheme', () => {
    expect(buildContinueProbeCommand('/home/user/p')).toContain("'-home-user-p'")
  })
})

describe('buildRemoteLaunchCommand', () => {
  it('builds a channel-less launch with cd, --continue and a quoted model', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/home/user/p', model: 'claude-opus-4-8[1m]', continue: true })
    expect(cmd).toContain("cd '/home/user/p'")
    expect(cmd).toContain('--continue')
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'")
    expect(cmd).toContain('--dangerously-skip-permissions')
  })

  it('exports a PATH covering both macOS and Linux binary locations', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/p', model: 'm', continue: false })
    expect(cmd).toContain('export PATH=')
    expect(cmd).toContain('$HOME/.bun/bin')
    expect(cmd).toContain('$HOME/.local/bin')
  })

  it('omits --continue when continue is false', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/p', model: 'm', continue: false })
    expect(cmd).not.toContain('--continue')
  })

  // The effort level MUST ride the env var. Claude Code's settings.json schema
  // accepts only low|medium|high|xhigh and silently drops anything else, so the
  // fleet's "max" written into a settings file runs at high with no error and no
  // log -- measured 2026-08-06, seven config files claimed max while every agent
  // ran at high. If a future edit moves this back into settings.json or drops
  // the export, the regression is invisible in behaviour; this test is the alarm.
  it('exports the fleet effort level as an env var', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/p', model: 'm', continue: false })
    expect(cmd).toContain(`export CLAUDE_CODE_EFFORT_LEVEL='${FLEET_EFFORT_LEVEL}'`)
  })

  // A typo here ('maximum', 'MAX', 'ultra') would NOT fail loudly: the CLI parses
  // the env var against its own list and falls back to the default. Pin the value
  // to the known-good set so the mistake is caught here instead of silently
  // costing the whole fleet its effort level.
  it('uses an effort level the CLI actually recognises', () => {
    expect(EFFORT_LEVELS).toContain(FLEET_EFFORT_LEVEL)
  })

  it('never carries channel/token scaffolding (launch-only, channel-less)', () => {
    const cmd = buildRemoteLaunchCommand({ workdir: '/p', model: 'm', continue: true })
    expect(cmd).not.toContain('--channels')
    expect(cmd).not.toContain('ANTHROPIC_API_KEY')
    expect(cmd).not.toContain('TELEGRAM')
  })
})

describe('classifyRunState', () => {
  it('running when the session is present in the list output', () => {
    expect(classifyRunState('agent-a\nagent-x\n', 'agent-x', true)).toBe('running')
    expect(classifyRunState('agent-a\nagent-x\n', 'agent-x', false)).toBe('running')
  })

  it('stopped when the session is absent but the list query succeeded', () => {
    expect(classifyRunState('agent-a\n', 'agent-x', true)).toBe('stopped')
    expect(classifyRunState('agent-a\n', 'agent-x', false)).toBe('stopped')
  })

  it('unreachable for a remote agent when the query itself failed (null)', () => {
    expect(classifyRunState(null, 'agent-x', true)).toBe('unreachable')
  })

  it('stopped (not unreachable) for a local agent when the query failed (no tmux)', () => {
    expect(classifyRunState(null, 'agent-x', false)).toBe('stopped')
  })
})
