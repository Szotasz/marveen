// MAINAUTH1107 (Samu 72329, closing the 72308 finding): a main pane parked at Claude Code's "Detected a custom API key"
// question is not idle, so the manual restart gate answers 409 restart-blocked while it is up.
//  (a) After A the question does not come up on the main pane: on a subscription install the pane gets no key (the
//      post-file unsets it after CFG_ENV), and in api / key-only mode the approval is stamped by applyMainAuth before
//      every launch (main-auth.test.ts "api: the pane ends with exactly the key", main-auth-wiring.test.ts).
//  (b) If it still does (a pane started by an older version, a stamp that could not be written): the channel-monitor
//      menu recovery (main session included, 45 s confirm) classifies it as a plain blocking menu, NOT as a permission
//      prompt, a consent dialog or a first-run gate, and sends Escape. Measured on Claude Code 2.1.319 with fake
//      credentials (agents/geri/work/apikulcs/probe5.sh): Escape stores "No"; with key + token the session continues
//      on the OAuth login, with the key alone on the key. The pane is idle afterwards, so the restart gate passes.
// The two captures below are those measured panes (the key's tail masked); this pins their classification.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectPaneState, detectsBlockingMenu, detectsFirstRunGate, detectsModelConsentDialog, detectsPermissionDialog, paneLooksIdle } from '../pane-state.js'

const RULE = '─'.repeat(160)
const PARKED = [
  '',
  RULE,
  '  Detected a custom API key in your environment',
  '',
  '  ANTHROPIC_API_KEY: (masked)',
  '',
  '  Do you want to use this API key?',
  '',
  '    Yes',
  '  ❯ No (recommended)',
  '',
  '  Enter to confirm · Esc to cancel',
  '',
].join('\n')
const AFTER_ESCAPE = [
  ' ▐▛███▛█   Claude Code v2.1.319',
  '▝▜██████▀  Sonnet 5.5 · Claude API',
  ' ▝▝   ▝▝   ~/proj',
  '',
  '⚠ Remote managed settings failed to load (authentication rejected (401)) · no remote policy applied · /status for details',
  '',
  RULE,
  '❯ ',
  RULE,
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                                                                                         ◐ medium · /effort',
  '',
].join('\n')

describe('the API-key question on the main pane', () => {
  it('parked: not idle (restart-blocked), and a plain blocking menu, nothing a blind Escape must not answer', () => {
    expect(paneLooksIdle(PARKED)).toBe(false)
    expect(detectPaneState(PARKED)).toBe('unknown')
    expect(detectsFirstRunGate(PARKED)).toBeNull()
    expect(detectsPermissionDialog(PARKED)).toBe(false)
    expect(detectsModelConsentDialog(PARKED)).toBe(false)
    expect(detectsBlockingMenu(PARKED)).toBe(true)
  })
  it('after the Escape: idle again, so the manual restart gate lets a restart through', () => {
    expect(detectsBlockingMenu(AFTER_ESCAPE)).toBe(false)
    expect(paneLooksIdle(AFTER_ESCAPE)).toBe(true)
  })
  it('the channel-monitor menu recovery walks the main session and answers a plain blocking menu with Escape', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'web', 'channel-monitor.ts'), 'utf-8')
    expect(src).toContain('const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]')
    expect(src).toContain("const inMenu = firstRunGate != null || (!t.gateOnly && pane != null && detectsBlockingMenu(pane))")
    expect(src).toMatch(/'Session parked in a blocking interactive menu -- sending Escape to recover'\)\n\s+try \{\n\s+execFileSync\(tmuxBin\(\), \['send-keys', '-t', exactTmuxTarget\(t\.session\), 'Escape'\]/)
  })
})
