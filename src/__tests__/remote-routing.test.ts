import { describe, it, expect } from 'vitest'
import { resolveRemoteConfig } from '../web/agent-config.js'
import { buildTmuxInvocation, sessionInList, SSH_OPTS } from '../web/ssh-tmux.js'

// The message-router / schedule-runner wiring resolves a host from the agent's
// config and routes its tmux calls through buildTmuxInvocation. These tests
// lock the END-TO-END transport decision using the real functions (no db, no
// tmux): a remote-configured agent must drive an `ssh` invocation, a local one
// must stay on the bare tmux binary. (The loops themselves import db.js, whose
// native better-sqlite3 binding is ABI-mismatched in this test runtime, so they
// cannot be imported here -- but every primitive they call is covered.)

const TMUX = '/usr/bin/tmux'

function transportFor(agentConfigJson: string, session: string) {
  const host = resolveRemoteConfig(agentConfigJson).host
  return buildTmuxInvocation(host, TMUX, ['list-sessions', '-F', '#{session_name}'])
    && { host, inv: buildTmuxInvocation(host, TMUX, ['send-keys', '-t', session, '-l', 'hi']) }
}

describe('delivery transport selection', () => {
  it('a remote-configured agent routes its tmux send over ssh', () => {
    const { host, inv } = transportFor(
      '{"remoteHost":"devbox","remoteWorkdir":"/home/user/proj"}',
      'agent-dev',
    )
    expect(host).toBe('devbox')
    expect(inv.file).toBe('ssh')
    expect(inv.args.slice(0, SSH_OPTS.length)).toEqual([...SSH_OPTS])
    expect(inv.args).toContain('devbox')
  })

  it('a local agent stays on the bare tmux binary (no ssh) -- local behavior preserved', () => {
    const { host, inv } = transportFor('{}', 'agent-dev')
    expect(host).toBeNull()
    expect(inv.file).toBe(TMUX)
    expect(inv.args).toEqual(['send-keys', '-t', 'agent-dev', '-l', 'hi'])
    expect(inv.args).not.toContain('ssh')
  })

  it('a half-configured (invalid) remote agent falls back to local transport', () => {
    const { host, inv } = transportFor(
      '{"remoteHost":"devbox","remoteWorkdir":"~/bad"}',
      'agent-dev',
    )
    expect(host).toBeNull()
    expect(inv.file).toBe(TMUX)
  })
})

describe('sessionInList existence check (shared by router + scheduler)', () => {
  it('finds the exact remote/local session name in list-sessions output', () => {
    const listOutput = 'agent-other\nagent-dev\nmarveen-channels\n'
    expect(sessionInList(listOutput, 'agent-dev')).toBe(true)
    expect(sessionInList(listOutput, 'agent-missing')).toBe(false)
  })
})
