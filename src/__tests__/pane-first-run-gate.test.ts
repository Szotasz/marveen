import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsFirstRunGate, detectPaneState, detectsBlockingMenu, firstRunAcceptKeys } from '../pane-state.js'

// Fresh-install first-run gate detection (card 5F37BB84, Oligo2000 VPS
// 2026-07-22). A sub-agent session parked on a Claude Code first-run dialog
// (folder-trust / bypass-permissions acceptance / login picker) has no idle
// footer and no busy signal, so detectPaneState reads 'unknown' and every
// scheduled task defers forever -- while a forceSend task typed its prompt
// blindly into the dialog. detectsFirstRunGate names the blocker so the
// scheduler can defer with a reasoned retry and the channel-monitor can
// answer the dialog chain instead of Escape-quitting the TUI.

const TRUST_PANE = [
  '╭──────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?           │',
  '│                                                  │',
  '│ /home/gabor/marveen/agents/nova                  │',
  '│                                                  │',
  '│ Claude Code may read, analyze and edit files in  │',
  '│ this folder.                                     │',
  '│                                                  │',
  '│ ❯ 1. Yes, proceed                                │',
  '│   2. No, exit                                    │',
  '╰──────────────────────────────────────────────────╯',
  '   Enter to confirm · Esc to exit',
].join('\n')

const BYPASS_PANE = [
  '╭──────────────────────────────────────────────────╮',
  '│ Bypass Permissions mode                          │',
  '│                                                  │',
  '│ In Bypass Permissions mode, Claude Code will not │',
  '│ ask for your approval before running potentially │',
  '│ dangerous commands.                              │',
  '│                                                  │',
  '│ ❯ 1. No, exit                                    │',
  '│   2. Yes, I accept                               │',
  '╰──────────────────────────────────────────────────╯',
].join('\n')

const LOGIN_PANE = [
  ' Welcome to Claude Code',
  '',
  ' Select login method:',
  '',
  ' ❯ 1. Claude account with subscription',
  '   2. Anthropic Console account',
  '',
  '   Enter to confirm',
].join('\n')

const THEME_PANE = [
  ' Welcome to Claude Code',
  '',
  ' Choose the text style that looks best with your terminal:',
  '',
  ' ❯ 1. Dark mode',
  '   2. Light mode',
].join('\n')

const WELCOME_TOUR_PANE = [
  ' Welcome to Claude Code!',
  '',
  ' Claude Code is a CLI tool for agentic coding.',
  '',
  ' Press Enter to continue',
].join('\n')

// Normal fresh-session layout: welcome banner + EMPTY input box, footer not
// yet rendered. This pane is usable (a prompt can land), NOT a gate.
const FRESH_SESSION_PROMPT_PANE = [
  ' Welcome to Claude Code',
  '',
  ' model: claude-opus-4-8   cwd: /home/gabor/marveen/agents/nova',
  '',
  '──────────────────────────────────────────────────',
  ' ❯ ',
  '──────────────────────────────────────────────────',
].join('\n')

// Healthy idle pane whose scrollback QUOTES the trust-dialog phrase (an agent
// discussing this very bug). The live idle footer proves the prompt is up.
const IDLE_WITH_QUOTE_PANE = [
  ' The customer pane showed "Do you trust the files in this folder?" at boot.',
  '',
  '──────────────────────────────────────────────────',
  ' ❯ ',
  '──────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Busy pane quoting the phrase mid-turn.
const BUSY_WITH_QUOTE_PANE = [
  ' Analyzing the report: "Do you trust the files in this folder?" parks agents.',
  ' Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)',
].join('\n')

// The SAME dialog as TRUST_PANE, as Claude Code 2.1.246 actually renders it --
// captured live on 2026-09-01 from a `claude` started in a throwaway directory
// (tmux capture-pane), not written from memory. Only the workspace path is
// swapped for a generic one; every other line is verbatim, including the
// unboxed layout, the marketing lead-in and the changed option text.
//
// Two things changed at once, which is why one string cannot cover both
// versions: the question "Do you trust the files in this folder?" is GONE
// (zero occurrences in the 2.1.246 binary), and the option is no longer
// "Yes, proceed" but "Yes, I trust this folder".
const TRUST_PANE_2_1_246 = [
  '────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' /home/gabor/marveen/agents/nova',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
  ' folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

// Negative control for the NEW anchor. The option text is short and eminently
// quotable -- an agent explaining this very incident types it into a live
// session. A visible idle footer means the real prompt is up, so this must
// never read as a gate (same discipline as IDLE_WITH_QUOTE_PANE above).
const IDLE_WITH_NEW_QUOTE_PANE = [
  ' A telepitesnel az elso opcio: "Yes, I trust this folder" -- ezt kell valaszolni.',
  '',
  '──────────────────────────────────────────────────',
  ' ❯ ',
  '──────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Negative control Marveen asked for: an ordinary working pane, no dialog of
// any kind. If this ever classifies as a gate, the detector is matching noise.
const ORDINARY_PANE = [
  ' $ npm test',
  ' Test Files  325 passed (325)',
  '',
  '──────────────────────────────────────────────────',
  ' ❯ ',
  '──────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// The SAME dialog again, as Claude Code 2.1.252 renders it -- captured live on
// 2026-09-01 from an ISOLATED install (npm install --prefix into a throwaway
// directory; the global 2.1.246 was left alone and re-checked afterwards).
// Only the workspace path is genericised.
//
// TWO further breaks on top of the reworded text, six patch releases later:
//   * the "1." / "2." numbering is GONE, so typing "1" selects nothing;
//   * "No, exit" is FIRST and is the highlighted option, so the Enter that
//     followed the useless "1" CONFIRMED the exit.
// A fresh install therefore did not park -- it quit, and our own code chose it.
const TRUST_PANE_2_1_252 = [
  '────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' /home/gabor/marveen/agents/nova',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this",
  ' folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

// A trust-shaped panel whose accept option is missing entirely: the layout is
// not one we model, so the answer must be "send nothing".
const TRUST_PANE_UNKNOWN_SHAPE = [
  ' Quick safety check: Is this a project you created or one you trust?',
  '',
  ' ❯ Maybe later',
  '   No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

describe('detectsFirstRunGate', () => {
  it('classifies the folder-trust dialog', () => {
    expect(detectsFirstRunGate(TRUST_PANE)).toBe('trust')
  })

  // TRUSTGATE901: the 2.1.246 rewrite. This is the regression that shipped --
  // the old pattern returns null here, the pane falls through to the generic
  // blocking-menu recovery, and that sends Escape, which on this dialog is
  // "No, exit". A fresh install quit at startup.
  it('classifies the REWRITTEN folder-trust dialog (Claude Code 2.1.246)', () => {
    expect(detectsFirstRunGate(TRUST_PANE_2_1_246)).toBe('trust')
  })

  // Both versions at once, so a later edit cannot "simplify" the alternation
  // down to whichever string it happens to see first.
  it('covers BOTH dialog versions, not one of them', () => {
    expect([detectsFirstRunGate(TRUST_PANE), detectsFirstRunGate(TRUST_PANE_2_1_246)])
      .toEqual(['trust', 'trust'])
  })

  it('does NOT flag an idle pane quoting the NEW option text', () => {
    expect(detectsFirstRunGate(IDLE_WITH_NEW_QUOTE_PANE)).toBeNull()
  })

  it('does NOT flag an ordinary working pane', () => {
    expect(detectsFirstRunGate(ORDINARY_PANE)).toBeNull()
  })

  it('classifies the bypass-permissions acceptance dialog', () => {
    expect(detectsFirstRunGate(BYPASS_PANE)).toBe('bypass-permissions')
  })

  it('classifies the login picker (wins over the welcome banner it renders under)', () => {
    expect(detectsFirstRunGate(LOGIN_PANE)).toBe('login')
  })

  it('classifies the theme picker (wins over the welcome banner)', () => {
    expect(detectsFirstRunGate(THEME_PANE)).toBe('theme')
  })

  it('classifies the onboarding welcome/tour screen', () => {
    expect(detectsFirstRunGate(WELCOME_TOUR_PANE)).toBe('welcome')
  })

  it('does NOT flag the normal fresh-session prompt under the welcome banner', () => {
    expect(detectsFirstRunGate(FRESH_SESSION_PROMPT_PANE)).toBeNull()
  })

  it('does NOT flag an idle pane that merely quotes the dialog text', () => {
    expect(detectsFirstRunGate(IDLE_WITH_QUOTE_PANE)).toBeNull()
  })

  it('does NOT flag a busy pane that quotes the dialog text', () => {
    expect(detectsFirstRunGate(BUSY_WITH_QUOTE_PANE)).toBeNull()
  })

  it('returns null on empty/whitespace panes', () => {
    expect(detectsFirstRunGate('')).toBeNull()
    expect(detectsFirstRunGate('   \n  ')).toBeNull()
  })

  it('documents WHY the gate is needed: detectPaneState reads these dialogs as unknown', () => {
    // 'unknown' means isSessionReadyForPrompt stays false forever -- the
    // scheduled-task pile-up. The gate detector is what names the blocker.
    expect(detectPaneState(TRUST_PANE)).toBe('unknown')
    expect(detectPaneState(LOGIN_PANE)).toBe('unknown')
  })

  it('trust dialog would also read as a generic blocking menu (Escape would QUIT it) -- the first-run check must win', () => {
    // "Esc to exit" matches the generic menu detector; the monitor's generic
    // recovery is Escape, which on this dialog selects "No, exit" and quits
    // the TUI. The call-site ordering (firstRunGate checked first) is pinned
    // by the source-contract test below.
    expect(detectsBlockingMenu(TRUST_PANE)).toBe(true)
  })
})

// --- source contracts (same style as send-prompt-force-send-gate.test.ts) ---

const SCHEDULE_RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
const CHANNEL_MONITOR = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('first-run gate wiring contracts', () => {
  it('the scheduler forceSend path defers on a first-run gate BEFORE the bypass injects', () => {
    const gateIdx = SCHEDULE_RUNNER.indexOf('const forceGate = pane != null ? detectsFirstRunGate(pane) : null')
    const bypassLogIdx = SCHEDULE_RUNNER.indexOf("'forceSend=true, bypassing busy-state check'")
    expect(gateIdx).toBeGreaterThan(0)
    expect(bypassLogIdx).toBeGreaterThan(gateIdx)
    // The deferral routes through the pending-retry queue as 'first-run'.
    expect(SCHEDULE_RUNNER).toMatch(/if \(forceGate\) \{[\s\S]{0,400}?return 'first-run'/)
  })

  it("the non-forceSend busy path distinguishes 'first-run' so the retry reason names the blocker", () => {
    expect(SCHEDULE_RUNNER).toMatch(/const gate = notReadyPane != null \? detectsFirstRunGate\(notReadyPane\) : null/)
  })

  it("'first-run' is exempt from skipIfBusy (queued like mcp-missing, never dropped)", () => {
    expect(SCHEDULE_RUNNER).toMatch(/result === 'first-run'[\s\S]{0,700}?insertPendingTaskRetryIfNew\(task\.name, agentName, now, 'first-run'\)/)
  })

  it('the channel-monitor answers first-run dialogs instead of sending Escape', () => {
    const gateIdx = CHANNEL_MONITOR.indexOf('const firstRunGate = pane != null ? detectsFirstRunGate(pane) : null')
    expect(gateIdx).toBeGreaterThan(0)
    // The Escape recovery must be in the ELSE branch after the first-run
    // handling, and the login picker must be alert-only (no keystrokes).
    expect(CHANNEL_MONITOR).toMatch(/if \(firstRunGate === 'login'\) \{[\s\S]{0,600}?no keystrokes sent/)
    expect(CHANNEL_MONITOR).toMatch(/\} else if \(firstRunGate\) \{[\s\S]{0,400}?await answerFirstRunGates\(t\.session\)/)
  })

  it('answerFirstRunGates never answers the login picker and never sends Escape', () => {
    const fnIdx = AGENT_PROCESS.indexOf('export async function answerFirstRunGates(')
    expect(fnIdx).toBeGreaterThan(0)
    const fn = AGENT_PROCESS.slice(fnIdx, AGENT_PROCESS.indexOf('// Post-(re)start identity setup', fnIdx))
    expect(fn).toContain("if (gate === 'login') return 'login'")
    expect(fn).not.toContain("'Escape'")
  })

  it('startAgentProcess stamps per-project trust in the config root the session boots from', () => {
    const stampIdx = AGENT_PROCESS.indexOf('stampProjectTrustForDir(\n      claudeConfigDir')
    const launchIdx = AGENT_PROCESS.indexOf("runTmux(null, ['new-session', '-d', '-s', session, cmd]")
    expect(stampIdx).toBeGreaterThan(0)
    // The stamp must happen BEFORE the tmux session is spawned.
    expect(launchIdx).toBeGreaterThan(stampIdx)
  })
})

describe('firstRunAcceptKeys (TRUSTGATE901)', () => {
  // Numbered, "Yes" first and already highlighted -> confirm where we are.
  it('2.1.246 layout: the cursor already sits on yes, so just confirm', () => {
    expect(firstRunAcceptKeys(TRUST_PANE_2_1_246)).toEqual(['Enter'])
  })

  // Unnumbered, "No, exit" first AND highlighted -> move down, then confirm.
  // This is the regression that quit a fresh install.
  it('2.1.252 layout: moves the selection onto yes before confirming', () => {
    expect(firstRunAcceptKeys(TRUST_PANE_2_1_252)).toEqual(['Down', 'Enter'])
  })

  // The discriminating assertion: a naive "always Enter" answer -- which is
  // what the old code effectively did after typing a number that no longer
  // selects anything -- is WRONG here, and this fixture is what proves it.
  it('2.1.252 layout: a bare Enter would confirm "No, exit"', () => {
    expect(firstRunAcceptKeys(TRUST_PANE_2_1_252)).not.toEqual(['Enter'])
  })

  it('the older boxed dialog still resolves to a plain confirm', () => {
    expect(firstRunAcceptKeys(TRUST_PANE)).toEqual(['Enter'])
  })

  // Not-acting is the correct answer on an unmodelled layout: Escape is
  // "No, exit" by the dialog's own footer and Enter confirms the highlight.
  it('returns null when no unambiguous yes option exists (park, send nothing)', () => {
    expect(firstRunAcceptKeys(TRUST_PANE_UNKNOWN_SHAPE)).toBeNull()
  })

  it('returns null on a pane with no selection cursor at all', () => {
    expect(firstRunAcceptKeys(ORDINARY_PANE.replace('❯', ' '))).toBeNull()
  })

  // The bypass-permissions dialog answered by the SAME rule. Its accept row is
  // second, behind a first and highlighted "No, exit" -- the identical shape
  // that made the trust dialog dangerous once the numbering disappeared.
  it('bypass dialog: moves onto the accept row instead of typing its number', () => {
    expect(firstRunAcceptKeys(BYPASS_PANE)).toEqual(['Down', 'Enter'])
  })

  // HYPOTHETICAL, and labelled as such: this layout was NOT captured from any
  // release. It exists to prove the rule does not depend on the numbering,
  // which is precisely what vanished from the trust dialog in 2.1.252. If the
  // bypass panel ever loses its prefixes the same way, this is the behaviour
  // we want -- and the old "type 2" answer would have selected nothing and
  // then confirmed the refusal.
  it('bypass dialog without numbering (hypothetical) still resolves correctly', () => {
    const unnumbered = [
      ' Bypass Permissions mode',
      '',
      ' ❯ No, exit',
      '   Yes, I accept',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n')
    expect(firstRunAcceptKeys(unnumbered)).toEqual(['Down', 'Enter'])
  })
})
