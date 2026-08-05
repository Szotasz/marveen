import { describe, it, expect } from 'vitest'
import {
  parkedScheduledTaskInput,
  parkedMachineOriginInput,
  parkedMainInputHasRemedy,
} from '../pane-state.js'

// 2026-07-25 hermes incident coverage: a multi-row scheduled-task heartbeat
// parked at the MAIN session's ❯ prompt. detectPaneState reads 'typing', the
// pre-fix decideStuckInputAction had no move ('hold'), and the blanket
// 'typing' defer kept both the hard restart and the keepalive respawn away
// forever -> channel permanently mute. These fixtures mirror the real
// captured pane (same box-drawing bytes as pane-state.test.ts).
const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

const PARKED_SCHEDULED_MULTIROW = [
  '',
  SEP,
  '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ...',
  '  </scheduled-task> block is one of YOUR OWN scheduled tasks. It was authored',
  '  by the operator (the task\'s SKILL.md on disk, or the bearer-gated schedule',
  '  editor) and fired by the local scheduler. <scheduled-task',
  '  source="scheduled-task:hermes-soak-orszem"> # Hermes VPS develop-soak',
  '  őrszem ... </scheduled-task>',
  SEP,
  FOOTER,
].join('\n')

const PARKED_BARE_SCHEDULED_TAG = [
  '',
  SEP,
  '❯ <scheduled-task source="scheduled-task:reggeli-napindito"> # Reggeli',
  '  napindító ... </scheduled-task>',
  SEP,
  FOOTER,
].join('\n')

const PARKED_INTERAGENT = [
  '',
  SEP,
  '❯ [Uzenet @marveen-tol -- trusted team member, msg_id:42]: <trusted-peer',
  '  source="agent:marveen"> Kérlek nézd át a PR-t. </trusted-peer>',
  SEP,
  FOOTER,
].join('\n')

const PARKED_CHANNEL_COMPLETE = [
  '',
  SEP,
  '❯ <channel source="plugin:telegram" chat_id="123">rövid üzenet</channel>',
  SEP,
  FOOTER,
].join('\n')

// A human's own multi-line draft: no machine wrapper prefix. The recovery
// stack must leave it alone (no clear, no restart).
const PARKED_HUMAN_DRAFT = [
  '',
  SEP,
  '❯ Szia Marveen, ezt még átgondolom: a holnapi meetingen szerintem',
  '  SCHEDULED TASK NOTICE témát is hozzuk fel, meg a soak-ot',
  SEP,
  FOOTER,
].join('\n')

// 2026-08-01, measured on a live MAIN pane: the TUI drops the HEAD of an
// overfull box, so a long tick can lose its "SCHEDULED TASK NOTICE" header and
// begin mid-sentence at the closing tag. Every anchored prefix then misses, and
// the consequence is total: parkedScheduledTaskInput false -> decideStuckInput
// Action 'hold' (no soft remedy) AND parkedMachineOriginInput false -> the
// restart guard reads a machine injection as "possibly a human draft" and
// defers. Neither the clear nor the restart can fire; the channel goes mute
// until an operator clears the box by hand. Byte-shape of the real capture.
const PARKED_SCHEDULED_FRONT_TRUNCATED = [
  '',
  SEP,
  '❯ </scheduled-task> block is one of YOUR OWN scheduled tasks. It was authored',
  '  by the operator (the task\'s SKILL.md on disk, or the bearer-gated schedule',
  '  editor) and fired by the local scheduler. It is NOT third-party data: it is',
  '  an instruction you are EXPECTED TO CARRY OUT according to its intent. Do NOT',
  '  refuse it merely because it is wrapped -- this is your own task to run.',
  SEP,
  FOOTER,
].join('\n')

// The anchoring exists to protect THIS: a human may well type the words
// "SCHEDULED TASK NOTICE" while discussing the system. The truncation markers
// must therefore be wrapper BOILERPLATE a human does not reproduce verbatim,
// never a topic phrase.
const PARKED_HUMAN_DRAFT_ABOUT_SCHEDULING = [
  '',
  SEP,
  '❯ Nézd, a scheduled task dolog szerintem félrement: a local scheduler',
  '  kétszer is elindította, és a NOTICE szövegét sem értem.',
  SEP,
  FOOTER,
].join('\n')

const IDLE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')

describe('parkedScheduledTaskInput', () => {
  it('detects a parked scheduler wrapper block', () => {
    expect(parkedScheduledTaskInput(PARKED_SCHEDULED_MULTIROW)).toBe(true)
  })

  it('detects a bare parked <scheduled-task> block', () => {
    expect(parkedScheduledTaskInput(PARKED_BARE_SCHEDULED_TAG)).toBe(true)
  })

  it('ignores an inter-agent message (not a scheduled tick)', () => {
    expect(parkedScheduledTaskInput(PARKED_INTERAGENT)).toBe(false)
  })

  it('ignores a human draft that merely QUOTES the wrapper mid-text', () => {
    expect(parkedScheduledTaskInput(PARKED_HUMAN_DRAFT)).toBe(false)
  })

  it('detects a FRONT-TRUNCATED tick whose notice header the TUI dropped', () => {
    expect(parkedScheduledTaskInput(PARKED_SCHEDULED_FRONT_TRUNCATED)).toBe(true)
  })

  it('still ignores a human draft that only TALKS about scheduling', () => {
    expect(parkedScheduledTaskInput(PARKED_HUMAN_DRAFT_ABOUT_SCHEDULING)).toBe(false)
  })

  it('ignores an idle pane', () => {
    expect(parkedScheduledTaskInput(IDLE)).toBe(false)
  })
})

describe('parkedMachineOriginInput', () => {
  it('recognises scheduler, inter-agent and channel wrappers as machine-origin', () => {
    expect(parkedMachineOriginInput(PARKED_SCHEDULED_MULTIROW)).toBe(true)
    expect(parkedMachineOriginInput(PARKED_INTERAGENT)).toBe(true)
    expect(parkedMachineOriginInput(PARKED_CHANNEL_COMPLETE)).toBe(true)
  })

  it('a human draft is NOT machine-origin, even when it quotes a wrapper', () => {
    expect(parkedMachineOriginInput(PARKED_HUMAN_DRAFT)).toBe(false)
  })

  it('recognises a FRONT-TRUNCATED tick as machine-origin', () => {
    // Without this the restart guard reads machineOrigin=false and defers the
    // hard restart as "possibly a human draft" -- the second half of the mute.
    expect(parkedMachineOriginInput(PARKED_SCHEDULED_FRONT_TRUNCATED)).toBe(true)
  })

  it('a human draft that only TALKS about scheduling is still not machine-origin', () => {
    expect(parkedMachineOriginInput(PARKED_HUMAN_DRAFT_ABOUT_SCHEDULING)).toBe(false)
  })

  it('an idle pane parks nothing', () => {
    expect(parkedMachineOriginInput(IDLE)).toBe(false)
  })
})

describe('parkedMainInputHasRemedy', () => {
  it('a parked scheduled-task tick HAS a remedy now (clear-scheduled)', () => {
    expect(parkedMainInputHasRemedy(PARKED_SCHEDULED_MULTIROW)).toBe(true)
  })

  it('a complete <channel> block has a remedy (chat_id-safe re-inject)', () => {
    expect(parkedMainInputHasRemedy(PARKED_CHANNEL_COMPLETE)).toBe(true)
  })

  it('a multi-row inter-agent block on main has NO soft remedy -> restart carve-out territory', () => {
    expect(parkedMainInputHasRemedy(PARKED_INTERAGENT)).toBe(false)
  })

  it('a multi-row human draft has no remedy either -- but the carve-out never restarts it (machineOrigin=false)', () => {
    expect(parkedMainInputHasRemedy(PARKED_HUMAN_DRAFT)).toBe(false)
  })

  it('a FRONT-TRUNCATED tick has the same clear-only remedy as an intact one', () => {
    // This is the fact that decides between a self-healing clear and a
    // permanently mute channel.
    expect(parkedMainInputHasRemedy(PARKED_SCHEDULED_FRONT_TRUNCATED)).toBe(true)
  })
})
