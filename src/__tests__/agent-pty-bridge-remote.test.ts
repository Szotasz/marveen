import { describe, it, expect } from 'vitest'
import { ptyAttachCommand, tmuxControlCommand } from '../web/agent-pty-bridge.js'

// The team-view live terminal failed for remote agents (Cassie on the jannoti
// laptop) with "can't find session: agent-cassie" -- the bridge spawned a LOCAL
// `tmux attach`, but the session lives on the remote host. These pure builders
// route the attach + control commands over ssh when the agent is remote.

describe('ptyAttachCommand', () => {
  it('attaches locally for a local agent (host = null)', () => {
    expect(ptyAttachCommand(null, 'agent-prof')).toEqual({
      file: 'tmux',
      args: ['attach-session', '-t', 'agent-prof'],
    })
  })

  it('attaches over ssh with a forced PTY for a remote agent', () => {
    expect(ptyAttachCommand('jannoti', 'agent-cassie')).toEqual({
      file: 'ssh',
      args: ['-tt', 'jannoti', 'tmux', 'attach-session', '-t', 'agent-cassie'],
    })
  })
})

describe('tmuxControlCommand', () => {
  it('runs control commands locally for a local agent', () => {
    expect(tmuxControlCommand(null, ['resize-window', '-t', 'agent-prof', '-x', '80', '-y', '24'])).toEqual({
      file: 'tmux',
      args: ['resize-window', '-t', 'agent-prof', '-x', '80', '-y', '24'],
    })
  })

  it('wraps control commands in ssh for a remote agent (window-pin on the remote host)', () => {
    expect(tmuxControlCommand('jannoti', ['set-window-option', '-t', 'agent-cassie', '-u', 'window-size'])).toEqual({
      file: 'ssh',
      args: ['jannoti', 'tmux', 'set-window-option', '-t', 'agent-cassie', '-u', 'window-size'],
    })
  })
})
