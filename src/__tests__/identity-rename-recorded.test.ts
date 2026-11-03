import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { identitySlashCommands } from '../web/agent-process.js'
import { recordInjectedPrompt, getInjectedPrompt, matchesInjectedPrompt } from '../web/injected-prompt-registry.js'
import {
  decideStuckInputAction, parkedChannelInput, parkedInputRowCount, parkedInputText,
  parkedMachineOriginInput, parkedScheduledTaskInput, shouldClearTruncatedPreamble,
  stuckInputSignature, type StuckInputActionFacts,
} from '../pane-state.js'

// RENAMEPARK1014. scheduleIdentitySetup types `/rename <name>` + Enter into every
// freshly started session. When the TUI swallows that Enter the line parks, and
// the stuck-input watcher -- which since GH #717 makes no move on a park it
// cannot attribute to us -- held it. Measured 2026-10-14: agent-leanpublisher sat
// ~15.5h behind a parked `/rename Lean Publisher` (log: 5x "holding", one
// give-up alert, then nothing). The command is now recorded in the
// injected-prompt registry before it is typed, so the parked scrape matches and
// the watcher submits it.

// The parked pane as captured on agent-leanpublisher (store/stuck-input-cleared/
// 20261014-155706-leanpublisher-manual.txt), with a line of scrollback above.
const PARKED_RENAME = [
  'earlier output',
  '',
  '─────────────────────────────────────────────────────────────── Lean Publisher ─',
  '❯ /rename Lean Publisher',
  '────────────────────────────────────────────────────────────────────────────────',
  '  Sonnet 5 | ctx 11% | 7d 5%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Mirrors the fact-gathering in recoverStuckInputForSession for a sub-agent
// (allowPlainReinject = true), first attempt (no escalation).
function facts(session: string, pane: string): StuckInputActionFacts {
  const block = parkedChannelInput(pane)
  return {
    escalate: false,
    rowCount: parkedInputRowCount(pane),
    blockComplete: block != null && block.complete && block.block != null,
    blockTruncated: block != null && !block.complete,
    truncatedPreamble: shouldClearTruncatedPreamble(pane),
    allowPlainReinject: true,
    hasPlainText: parkedInputText(pane) != null,
    scheduledTaskBlock: parkedScheduledTaskInput(pane),
    machineOrigin: parkedMachineOriginInput(pane),
    recordedMatch: matchesInjectedPrompt(parkedInputText(pane), getInjectedPrompt(session)),
  }
}

describe('identity /rename is recorded so a parked one is recoverable (RENAMEPARK1014)', () => {
  it('the fixture is a real park: the watcher sees it as stuck, single row, no machine marker', () => {
    expect(stuckInputSignature(PARKED_RENAME)).not.toBeNull()
    expect(parkedInputRowCount(PARKED_RENAME)).toBe(1)
    expect(parkedMachineOriginInput(PARKED_RENAME)).toBe(false)
  })

  it('without a record the watcher holds it (the measured 15.5h park)', () => {
    expect(decideStuckInputAction(facts('agent-rename-unrecorded', PARKED_RENAME))).toBe('hold')
  })

  it('with the identity command recorded, the parked scrape matches and the watcher submits it', () => {
    const session = 'agent-rename-recorded'
    recordInjectedPrompt(session, identitySlashCommands('Lean Publisher')[0])
    const f = facts(session, PARKED_RENAME)
    expect(f.recordedMatch).toBe(true)
    expect(decideStuckInputAction(f)).toBe('enter')
  })

  it('a record for a DIFFERENT name does not match -- a human-typed /rename stays untouched', () => {
    const session = 'agent-rename-other'
    recordInjectedPrompt(session, identitySlashCommands('Lean Writer')[0])
    expect(decideStuckInputAction(facts(session, PARKED_RENAME))).toBe('hold')
  })

  // The 24-char floor in matchesInjectedPrompt guards against a short FRAGMENT
  // counting as evidence. `/rename Lean Publisher` squashes to 20 chars, so
  // without the exact-match exception the record above could never match.
  it('the whole short record matches, but a short fragment of a record still does not', () => {
    const rec = { text: '/rename Lean Publisher', at: 0 }
    expect(matchesInjectedPrompt('/rename Lean Publisher', rec)).toBe(true)
    expect(matchesInjectedPrompt('/rename Lean', rec)).toBe(false)
    expect(matchesInjectedPrompt('the', { text: 'the quick brown fox jumps over the lazy dog', at: 0 })).toBe(false)
    // An exact short match needs the record: no record, no match.
    expect(matchesInjectedPrompt('/rename Lean Publisher', null)).toBe(false)
  })

  // Review of #1948 (2026-10-15): the exception is not `/rename`-only. The
  // dashboard operator commands `/login` and `/mcp` are recorded by
  // sendPromptToSession too, and are far under the floor. A parked one now
  // matches its own record (the watcher submits it) -- intended, and pinned
  // here so a later change cannot narrow or widen it silently.
  it('a short operator command (/login, /mcp) matches its own record, and only its own', () => {
    expect(matchesInjectedPrompt('/login', { text: '/login', at: 0 })).toBe(true)
    expect(matchesInjectedPrompt('/mcp', { text: '/mcp', at: 0 })).toBe(true)
    expect(matchesInjectedPrompt('/mcp', { text: '/login', at: 0 })).toBe(false)
    expect(matchesInjectedPrompt('/login', null)).toBe(false)
  })

  // Source contract, same reason as the IDENTLANE910 tests in
  // session-send-lock.test.ts: the send sits on fire-and-forget timers against
  // a live tmux pane, so it is not driven end to end in CI. What is checkable is
  // that the record is made, for the same text, BEFORE the keystroke.
  it('scheduleIdentitySetup records the command before the send-keys that types it', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-process.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('export async function scheduleIdentitySetup'))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    const recordAt = body.indexOf('recordInjectedPrompt(session, cmd)')
    const sendAt = body.indexOf("runTmux(host, ['send-keys', '-t', exactTmuxTarget(session), cmd, 'Enter']")
    expect(recordAt).toBeGreaterThanOrEqual(0)
    expect(sendAt).toBeGreaterThan(recordAt)
  })
})
