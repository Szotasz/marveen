// The restart gate blocked three different agents on 2026-09-22 for three
// different reasons, and all three shared one shape: the condition being waited
// on had no path to becoming false. From the outside a gate that is being
// careful and a gate that is wedged look identical -- both say "not yet".
//
// THIS FILE COVERS ONE OF THOSE CAUSES, AND ONLY THE READER SIDE OF IT. The
// header used to claim it also pinned the alert's sender and the wording
// escalation; it did not -- all five tests here exercise the transcript reader
// (2026-09-24 review). Saying so mattered more than it looks: a header that
// names a rule is read as evidence that the rule is measured, and nobody
// re-checks it. The other two now live in
// context-restart-gate-wiring.test.ts, driven through the production entry
// points, with the mutants they kill named next to them.
//
//  GATEMTIME922  -- transcript activity was read from the FILE MTIME, and idle
//                   sessions keep appending untimestamped bookkeeping records,
//                   so the required quiet window never arrived (Willy: 240 min
//                   blocked with no work at all). THIS is what the file below
//                   measures.
//  GATESENDER922 -- the supervisory alert was written in the WATCHED AGENT'S
//                   name, so a genuine system message failed the fleet's own
//                   authenticity rule (from_agent='system'). Covered in
//                   context-restart-gate-wiring.test.ts, not here.

import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLastConversationTsFromProjectDir } from '../web/active-model.js'

const WORKING_DIR = '/Users/x/marveen'
const ENCODED = '-Users-x-marveen'

function fixtureWith(lines: string[], mtimeEpochSec?: number): string {
  const root = mkdtempSync(join(tmpdir(), 'gate-never-clears-'))
  const dir = join(root, 'projects', ENCODED)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  if (mtimeEpochSec !== undefined) utimesSync(file, mtimeEpochSec, mtimeEpochSec)
  return root
}

const turnAt = (iso: string) => JSON.stringify({ type: 'assistant', timestamp: iso, message: { role: 'assistant' } })
// The exact record types measured on Willy's transcript. None carries a timestamp.
const bookkeeping = [
  JSON.stringify({ type: 'atis-latch', value: 1 }),
  JSON.stringify({ type: 'mode', mode: 'default' }),
  JSON.stringify({ type: 'last-prompt', text: 'x' }),
  JSON.stringify({ type: 'custom-title', title: 'x' }),
  JSON.stringify({ type: 'agent-name', name: 'willy' }),
  JSON.stringify({ type: 'file-history-snapshot', files: [] }),
  JSON.stringify({ type: 'artifact-autoreact-ledger', seen: [] }),
]

describe('GATEMTIME922 -- transcript activity is the last TURN, not the last WRITE', () => {
  it('ignores untimestamped bookkeeping lines appended after the last real turn', () => {
    // The shape that wedged Willy: a real turn at 09:35:56Z, then bookkeeping
    // records written while the session sat idle. mtime is deliberately set far
    // later, exactly as the live file behaved (mtime 12:24 vs last turn 11:35).
    const root = fixtureWith([turnAt('2026-09-22T09:35:56.000Z'), ...bookkeeping],
      Math.floor(Date.parse('2026-09-22T10:24:19.000Z') / 1000))
    const ts = readLastConversationTsFromProjectDir(WORKING_DIR, root)
    expect(ts).toBe(Date.parse('2026-09-22T09:35:56.000Z'))
  })

  it('an ISO date quoted inside message text cannot masquerade as activity', () => {
    // Only a TOP-LEVEL timestamp counts. A regex over the raw tail would have
    // picked the 2027 date out of the message body and reported the session as
    // active into next year.
    const root = fixtureWith([
      turnAt('2026-09-22T09:35:56.000Z'),
      JSON.stringify({ type: 'user', message: { content: 'deadline is "timestamp":"2027-01-01T00:00:00.000Z"' } }),
    ])
    expect(readLastConversationTsFromProjectDir(WORKING_DIR, root))
      .toBe(Date.parse('2026-09-22T09:35:56.000Z'))
  })

  it('takes the NEWEST timestamped turn, not the last line of the file', () => {
    const root = fixtureWith([
      turnAt('2026-09-22T09:35:56.000Z'),
      turnAt('2026-09-22T11:02:03.000Z'),
      ...bookkeeping,
    ])
    expect(readLastConversationTsFromProjectDir(WORKING_DIR, root))
      .toBe(Date.parse('2026-09-22T11:02:03.000Z'))
  })

  it('returns null when the transcript holds no timestamped line at all', () => {
    // Not a lie either way: the caller falls back to mtime and logs that it did,
    // which is the one case where mtime really is the best available signal.
    const root = fixtureWith([...bookkeeping])
    expect(readLastConversationTsFromProjectDir(WORKING_DIR, root)).toBeNull()
  })

  it('finds a turn that sits beyond the first tail window', () => {
    // A long tool-result burst can push every timestamped line out of a small
    // tail. The widening passes are what stop that from reading as "no turns".
    const filler = Array.from({ length: 400 }, (_, i) =>
      JSON.stringify({ type: 'file-history-snapshot', pad: 'x'.repeat(2000), i }))
    const root = fixtureWith([turnAt('2026-09-22T09:35:56.000Z'), ...filler])
    const ts = readLastConversationTsFromProjectDir(WORKING_DIR, root, 4096)
    expect(ts).toBe(Date.parse('2026-09-22T09:35:56.000Z'))
  })
})
