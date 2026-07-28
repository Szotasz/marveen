import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectsFirstRunGate, detectPaneState, detectsBlockingMenu } from '../pane-state.js'

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

describe('detectsFirstRunGate', () => {
  it('classifies the folder-trust dialog', () => {
    expect(detectsFirstRunGate(TRUST_PANE)).toBe('trust')
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
