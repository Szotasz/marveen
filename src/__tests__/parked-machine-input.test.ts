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
})
