// A tmux session that still exists is not proof that an agent lives in it.
// When the Claude CLI exits, tmux keeps the session alive with a bare shell
// prompt in the pane: list-sessions still lists it, so runState says 'running'
// and the dashboard shows a perfectly idle agent that will never answer.
//
// The positive signal is the pane's FOREGROUND COMMAND. Measured on the live
// fleet (2026-09-06): every healthy agent pane reports 'claude.exe'; a session
// with no CLI in it reports its shell ('bash'). These tests pin that reading
// and, more importantly, pin the conjunction that keeps it honest: a shell
// reading alone never means dead while the pane still shows work in progress.

import { describe, it, expect } from 'vitest'
import { classifyPaneLiveness, activityState } from '../web/pane-liveness.js'

const SEP = '─'.repeat(40)
const IDLE_PANE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

describe('classifyPaneLiveness', () => {
  it('reads the measured healthy value as alive', () => {
    expect(classifyPaneLiveness('claude.exe')).toBe('alive')
  })

  it('reads every common shell as a dead pane', () => {
    for (const shell of ['bash', 'zsh', 'sh', 'fish', 'ksh', 'dash', 'tcsh', 'login', '-zsh']) {
      expect(classifyPaneLiveness(shell)).toBe('dead-shell')
    }
  })

  it('is case-insensitive about the command name', () => {
    expect(classifyPaneLiveness('ZSH')).toBe('dead-shell')
  })

  it('calls anything else alive -- an unknown foreground process is still a process', () => {
    expect(classifyPaneLiveness('node')).toBe('alive')
    expect(classifyPaneLiveness('claude')).toBe('alive')
  })

  it('reports unknown when tmux gave us nothing', () => {
    expect(classifyPaneLiveness(null)).toBe('unknown')
    expect(classifyPaneLiveness('')).toBe('unknown')
    expect(classifyPaneLiveness('   ')).toBe('unknown')
  })
})

describe('activityState', () => {
  it('a session that is not running is stopped, whatever the pane says', () => {
    expect(activityState({ running: false, pane: BUSY_PANE, paneCommand: 'claude.exe' })).toBe('stopped')
  })

  it('names the failure the card was opened for: session alive, CLI gone, pane idle', () => {
    expect(activityState({ running: true, pane: IDLE_PANE, paneCommand: 'bash' })).toBe('dead')
  })

  it('does NOT call it dead while the pane still shows work in progress', () => {
    // 180 samples across six live sessions on 2026-09-06 never showed a child
    // command, not even during tool calls -- but a working pane outranks the
    // reading anyway, so no future build can turn a busy agent into a corpse.
    expect(activityState({ running: true, pane: BUSY_PANE, paneCommand: 'bash' })).toBe('working')
  })

  it('keeps a live CLI on an empty prompt as idle, not dead', () => {
    expect(activityState({ running: true, pane: IDLE_PANE, paneCommand: 'claude.exe' })).toBe('idle')
  })

  it('falls back to idle when tmux could not report a foreground command', () => {
    expect(activityState({ running: true, pane: IDLE_PANE, paneCommand: null })).toBe('idle')
  })

  it('reports unknown when there is no pane to read', () => {
    expect(activityState({ running: true, pane: null, paneCommand: 'claude.exe' })).toBe('unknown')
  })

  it('calls a dead pane dead even when the leftover shell output reads as unknown', () => {
    expect(activityState({ running: true, pane: 'zsh: command not found: claudee', paneCommand: 'zsh' })).toBe('dead')
  })
})
