import { describe, it, expect } from 'vitest'
import { buildRemoteLaunchCommand, classifyRunState, classifyRunStateFromExit, buildContinueProbeCommand } from '../web/ssh-tmux.js'

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
