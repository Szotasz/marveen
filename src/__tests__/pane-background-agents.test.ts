import { describe, it, expect } from 'vitest'
import { detectPaneState, detectBackgroundAgents, isReadyForPrompt } from '../pane-state.js'

// Background (sub-)agents render as a block BELOW the idle footer: a blank row,
// a `⏺ main` row for the session's own thread, then one `◯ <type>  <label>
// <elapsed> · ↓ <n> tokens` row per agent. Every shape below is a real
// `tmux capture-pane -p` tail from a fleet session (2026-10-16, Claude Code
// 2.1.301) with the agent name, task labels and token counts replaced by
// neutral ones; the glyphs, separators and column layout are the captured bytes.
//
// Two misreads came from this block, both measured on the live capture:
//   - main thread at turn start, footer clipped to `· e…` (the `esc to
//     interrupt` segment) by the longer subagent hint: the clipped footer was no
//     longer the LAST line, so the pane read 'unknown' (orange "ismeretlen").
//   - main thread mid-turn with several agents: the rows pushed the spinner and
//     the `esc to interrupt` footer out of the bottom live windows, so a running
//     turn read 'idle'.

const SEP = '─'.repeat(80)
const NAME_BAR = '─'.repeat(67) + ' AgentOne ─'

const row = (label: string, elapsed: string, tokens: string) =>
  `  ◯ general-purpose  ${label} ${elapsed} · ↓ ${tokens} tokens`

const ROWS = [
  row('Reviewing the first result fi…', '17m 23s', '171.9k'),
  row('Verifying the second checkout…', '16m 30s', '319.7k'),
]

// Main thread idle, waiting for its two agents.
const IDLE_WITH_AGENTS = [
  '  The first and second checks are still running.',
  '',
  '✻ Waiting for 2 background agents to finish',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ↓ to manage',
  '',
  '  ⏺ main',
  ...ROWS,
].join('\n')

// Main thread starting a turn: spinner without a token counter yet, and the
// footer clipped mid-`esc to interrupt`.
const TURN_START_WITH_AGENTS = [
  '✻ Waiting for 2 background agents to finish',
  '',
  '⏺ Agent "first check" finished · 17m 23s',
  '',
  '✢ Mulling… (21s)',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · /tasks to see subagents · e…',
  '',
  '  ⏺ main',
  ROWS[0],
].join('\n')

// Main thread mid-turn (token counter live) with five agents below the footer.
const BUSY_WITH_FIVE_AGENTS = [
  '⏺ Running 1 shell command…',
  '',
  '✽ Mulling… (1m 52s · ↓ 7.9k tokens)',
  '  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s',
  '     current work',
  '',
  NAME_BAR,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 2 shells · esc to interrupt · ↓ to manage',
  '',
  '  ⏺ main',
  row('Task one                      ', '6m 30s', '26.0k'),
  row('Task two                      ', '6m 28s', '31.2k'),
  row('Task three                    ', '6m 25s', '12.4k'),
  row('Task four                     ', '6m 21s', '8.8k'),
  row('Task five                     ', '6m 19s', '40.1k'),
].join('\n')

describe('background-agent block below the footer', () => {
  it('idle main thread with running agents reads idle, and the agents are counted', () => {
    expect(detectPaneState(IDLE_WITH_AGENTS)).toBe('idle')
    expect(detectBackgroundAgents(IDLE_WITH_AGENTS)).toEqual({ total: 2, running: 2, queued: 0 })
  })

  it('main thread at turn start with a clipped `esc to interrupt` reads busy, not unknown', () => {
    expect(detectPaneState(TURN_START_WITH_AGENTS)).toBe('busy')
    expect(isReadyForPrompt(TURN_START_WITH_AGENTS)).toBe(false)
    expect(detectBackgroundAgents(TURN_START_WITH_AGENTS)).toEqual({ total: 1, running: 1, queued: 0 })
  })

  it('main thread mid-turn with five agents reads busy, not idle', () => {
    expect(detectPaneState(BUSY_WITH_FIVE_AGENTS)).toBe('busy')
    expect(isReadyForPrompt(BUSY_WITH_FIVE_AGENTS)).toBe(false)
    expect(detectBackgroundAgents(BUSY_WITH_FIVE_AGENTS)).toEqual({ total: 5, running: 5, queued: 0 })
  })

  it('reads the same with blank rows below the block', () => {
    expect(detectPaneState(IDLE_WITH_AGENTS + '\n\n\n')).toBe('idle')
    expect(detectBackgroundAgents(IDLE_WITH_AGENTS + '\n\n\n')).toEqual({ total: 2, running: 2, queued: 0 })
  })

  it('a row without the elapsed/token tail is counted in total but not as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ◯ general-purpose  Some other task'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 2, queued: 0 })
  })

  it('a just-started agent (elapsed time, no token count yet) counts as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ◯ Explore  Find the callers                                  1s'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 3, queued: 0 })
  })

  // The row tail is `[elapsed, tokens, "N queued"]` joined with ` · ` (Claude
  // Code 2.1.301 source). The owner saw `1 queued` at the end of a row on the
  // card that read orange "ismeretlen".
  it('a row ending in `· N queued` is still running, and the queued messages are summed', () => {
    const pane = IDLE_WITH_AGENTS.replace(ROWS[1], ROWS[1] + ' · 2 queued') + '\n' + ROWS[0] + ' · 1 queued'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 3, queued: 3 })
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('the turn-start shape with a queued row reads busy, not unknown', () => {
    expect(detectPaneState(TURN_START_WITH_AGENTS + ' · 1 queued')).toBe('busy')
  })

  it('an idle agent (`waiting` instead of a clock) is not counted as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ◯ general-purpose  Parked task waiting · 1 queued'
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 2, queued: 1 })
  })

  it('no block -> null (plain idle footer, shells only)', () => {
    const pane = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage'].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('an unknown row shape under `⏺ main` is not counted: nothing is invented', () => {
    const pane = IDLE_WITH_AGENTS + '\n  ✔ general-purpose  Done task 3m 2s · ↓ 1.0k tokens'
    expect(detectBackgroundAgents(pane)).toBeNull()
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('an unknown row (a wrapped label) under a busy footer still reads busy', () => {
    const pane = BUSY_WITH_FIVE_AGENTS + '\n     continuation of a wrapped label'
    expect(detectPaneState(pane)).toBe('busy')
    expect(detectBackgroundAgents(pane)).toBeNull()
  })

  it('a `⏺ main` line that does not sit under the footer is not a block', () => {
    const pane = ['  some reply text', '  ⏺ main', ROWS[0], '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage'].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('a million-token row counts as running', () => {
    const pane = IDLE_WITH_AGENTS + '\n' + row('Long task', '40m 2s', '1.2M')
    expect(detectBackgroundAgents(pane)).toEqual({ total: 3, running: 3, queued: 0 })
  })

  it('agent rows without the `⏺ main` header are not a block', () => {
    const pane = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage', ROWS[0]].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
  })

  it('a block quoted in the scrollback (not at the bottom) does not count', () => {
    const pane = [
      '  ⏺ main',
      ROWS[0],
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · ↓ to manage',
    ].join('\n')
    expect(detectBackgroundAgents(pane)).toBeNull()
  })

  it('a clipped footer that is not an `esc to interrupt` prefix stays idle', () => {
    const pane = IDLE_WITH_AGENTS.replace(
      '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ↓ to manage',
      '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · /tasks to see subagents · ↓ to man…',
    )
    expect(detectPaneState(pane)).toBe('idle')
  })
})
