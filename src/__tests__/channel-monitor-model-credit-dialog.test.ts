// The model usage-credit dialog branch in the blocking-menu recovery pass.
//
// FABLEFALL1 established that the credit consent dialog must never get the
// generic recovery Escape: the CLI records Escape as `cancelled` and continues
// on the FALLBACK model, silently. Its answer is to press option 1, which is
// correct for the one dialog shape it detects -- there, option 1 IS "Continue
// with <configured model>".
//
// The gap this branch closes is the shape where that assumption does not hold:
// a dialog whose options do not include the configured model. Pressing 1 there
// either buys credits or moves the agent onto a model nobody chose, and because
// the modal then disappears, the pane, the dashboard and agent-config.json all
// keep naming the configured model. Such a dialog must ESCALATE, not guess.
//
// The pure decision is tested behaviourally below. A real tmux interaction
// cannot be driven from a unit test, so the wiring asserts read the source and
// lock in the structural invariants -- ordering, the absence of an Escape, and
// the send-lane discipline. This file deliberately does NOT import
// channel-monitor: loading it would pull in the live notification sinks.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  detectsModelConsentDialog,
  detectsModelCreditDialog,
  findModelCreditDialogOption,
} from '../pane-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MONITOR_PATH = join(__dirname, '..', 'web', 'channel-monitor.ts')
const src = readFileSync(MONITOR_PATH, 'utf-8')

// The blocking-menu recovery pass, from its banner comment to the next pass.
function menuRecoveryRegion(): string {
  const start = src.indexOf('// Blocking-menu recovery')
  const end = src.indexOf('// Stuck channel-input recovery', start)
  expect(start, 'menu-recovery region start not found').toBeGreaterThan(0)
  expect(end, 'menu-recovery region end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('model-credit dialog: escalate instead of guessing an option', () => {
  // A dialog BOTH detectors match, offering Fable and Sonnet. The agent parked
  // on it is configured for Haiku -- neither row names its model.
  const FABLE_SONNET_DIALOG = [
    '  Fable 5 now uses usage credits',
    "  You've used your included Fable 5 usage for this week. Continuing on Fable 5",
    '  uses usage credits, purchased separately from your plan.',
    '  ❯ 1. Continue with Fable 5',
    '    2. Switch to Sonnet 5 and continue',
    '  Enter to confirm · Esc to cancel',
  ].join('\n')

  it('a dialog offering no row for the configured model yields NO option (-> escalate)', () => {
    expect(detectsModelCreditDialog(FABLE_SONNET_DIALOG)).toBe(true)
    expect(findModelCreditDialogOption(FABLE_SONNET_DIALOG, 'claude-haiku-4-5-20251001')).toBeNull()
  })

  it('option 1 here would silently switch the agent -- which is why the branch runs first', () => {
    // This is the incident class in one assertion. The pane satisfies the
    // FABLEFALL1 detector too, so without this branch chained ahead of it the
    // monitor would press option 1 -- "Continue with Fable 5" -- on an agent
    // configured for Haiku, and nothing in the pane or the config would show it.
    expect(detectsModelConsentDialog(FABLE_SONNET_DIALOG)).toBe(true)
    const blindOptionOne = 1
    const configuredOption = findModelCreditDialogOption(FABLE_SONNET_DIALOG, 'claude-haiku-4-5-20251001')
    expect(configuredOption).not.toBe(blindOptionOne)
    expect(configuredOption).toBeNull()
  })

  it('still navigates when a row DOES name the configured model (escalation is not the default)', () => {
    expect(findModelCreditDialogOption(FABLE_SONNET_DIALOG, 'claude-fable-5')).toBe(1)
    expect(findModelCreditDialogOption(FABLE_SONNET_DIALOG, 'claude-sonnet-5')).toBe(2)
  })
})

describe('channel-monitor: model-credit dialog branch', () => {
  it('imports the pure detectors from pane-state', () => {
    expect(src).toMatch(/import\s*{[^}]*\bdetectsModelCreditDialog\b[^}]*}\s*from\s*['"]\.\.\/pane-state\.js['"]/s)
    expect(src).toMatch(/import\s*{[^}]*\bfindModelCreditDialogOption\b[^}]*}\s*from\s*['"]\.\.\/pane-state\.js['"]/s)
  })

  it('reads the configured model through the existing resolvers, main vs sub-agent', () => {
    // readConfiguredMainModel already encodes the .env-over-settings.json
    // precedence for the main session, and readAgentModel resolves a sub-agent's
    // model profile; re-implementing either here would drift.
    expect(src).toMatch(/import\s*{[^}]*\breadAgentModel\b[^}]*}\s*from\s*['"]\.\/agent-config\.js['"]/s)
    const region = menuRecoveryRegion()
    expect(region).toContain('const configuredModel = t.isMarveen')
    expect(region).toContain('? readConfiguredMainModel()')
    expect(region).toContain(": (t.agentName ? readAgentModel(t.agentName) : '')")
  })

  it('runs BEFORE the FABLEFALL1 branch and BEFORE the generic Escape branch', () => {
    // Ordering is the whole contract: FABLEFALL1 presses option 1, so it must
    // only see dialogs this branch has already declined to handle.
    const region = menuRecoveryRegion()
    const creditIdx = region.indexOf('} else if (pane != null && detectsModelCreditDialog(pane)) {')
    const fablefallIdx = region.indexOf('detectsModelConsentDialog(paneNow)')
    const genericEscapeIdx = region.indexOf("send-keys', '-t', t.session, 'Escape'")
    expect(creditIdx).toBeGreaterThan(0)
    expect(fablefallIdx).toBeGreaterThan(creditIdx)
    expect(genericEscapeIdx).toBeGreaterThan(fablefallIdx)
  })

  it('sends NO Escape and no blind option 1 in the credit branch (the whole point)', () => {
    const region = menuRecoveryRegion()
    // Still exactly one Escape send in the entire pass, and it is the generic
    // one -- the credit branch adds none.
    const escapes = region.match(/send-keys', '-t', t\.session, 'Escape'/g) ?? []
    expect(escapes.length).toBe(1)
    const creditIdx = region.indexOf('detectsModelCreditDialog(pane)')
    const fablefallIdx = region.indexOf('// FABLEFALL1:')
    const creditBranch = region.slice(creditIdx, fablefallIdx)
    // Match the CALL, not the word: the branch comment explains why Escape is
    // wrong here, so a bare substring check would flag its own rationale.
    expect(creditBranch).not.toContain("send-keys', '-t', t.session, 'Escape'")
    // The blind option-1 answer belongs to FABLEFALL1 only. Again the CALL,
    // not the name -- the navigation comment cites that helper's key sequence.
    expect(creditBranch).not.toContain('await dismissModelConsentDialogIfPresent(')
  })

  it('escalates with NO keystrokes when no option names the configured model', () => {
    const region = menuRecoveryRegion()
    const creditIdx = region.indexOf('detectsModelCreditDialog(pane)')
    const escalate = region.slice(region.indexOf('if (optionNum == null) {', creditIdx), region.indexOf('} else {', creditIdx))
    expect(escalate).toContain('NO keystrokes sent')
    expect(escalate).toContain('sendAlert(')
    // Nothing may be typed into the pane on this path.
    expect(escalate).not.toContain('send-keys')
  })

  it('navigates with digit + settle + Enter, under the send lane in recover mode', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('const optionNum = configuredModel ? findModelCreditDialogOption(pane, configuredModel) : null')
    // PANEWRITERS805: a probe+act keystroke writer takes the lane fail-closed.
    expect(region).toContain("await withSessionSendLock(t.session, null, 'recover'")
    const navIdx = region.indexOf("await withSessionSendLock(t.session, null, 'recover'")
    const nav = region.slice(navIdx)
    expect(nav).toContain("execFileSync(TMUX, ['send-keys', '-t', t.session, String(optionNum)], { timeout: 5000 })")
    expect(nav).toContain('await delay(150)')
    expect(nav).toContain("execFileSync(TMUX, ['send-keys', '-t', t.session, 'Enter'], { timeout: 5000 })")
    // Ordering within the sequence: digit, then settle, then Enter.
    const digitIdx = nav.indexOf('String(optionNum)], { timeout: 5000 })')
    const settleIdx = nav.indexOf('await delay(150)')
    const enterIdx = nav.indexOf("t.session, 'Enter'], { timeout: 5000 })")
    expect(settleIdx).toBeGreaterThan(digitIdx)
    expect(enterIdx).toBeGreaterThan(settleIdx)
  })

  it('re-probes INSIDE the lane and only presses when the option number is unchanged', () => {
    // A digit selects by POSITION. The detection capture predates the debounce
    // decision, so pressing on it could confirm a row that has since moved.
    const region = menuRecoveryRegion()
    const navIdx = region.indexOf("await withSessionSendLock(t.session, null, 'recover'")
    const nav = region.slice(navIdx)
    const reprobeIdx = nav.indexOf('const paneNow = capturePane(t.session)')
    const guardIdx = nav.indexOf('findModelCreditDialogOption(paneNow, configuredModel) !== optionNum')
    const pressIdx = nav.indexOf('String(optionNum)], { timeout: 5000 })')
    expect(reprobeIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(reprobeIdx)
    expect(pressIdx).toBeGreaterThan(guardIdx)
  })

  it('logs the fail-closed skip when a delivery holds the lane (a skip nobody logs is not a skip)', () => {
    const region = menuRecoveryRegion()
    expect(region).toContain('if (!nav.ran) {')
    expect(region).toContain('holds this pane send lane (fail-closed)')
  })
})
