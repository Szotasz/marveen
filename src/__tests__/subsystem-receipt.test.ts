import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase, createAgentMessage, getPendingMessages, getAgentMessage,
  markMessageDone, hasAgentMailbox, SUBSYSTEM_SENDERS,
} from '../db.js'
import { createCompletionReceipt } from '../web/routes/messages.js'
import { PROJECT_ROOT } from '../config.js'

// Completion receipts addressed to something that cannot read them.
//
// Atlas's flow-watchdog finding, 2026-08-09 (#306): closing a message from the
// scheduler mints a receipt back to "scheduler" -- which is a subsystem of this
// process, not an agent. No tmux session, no inbox, nothing to deliver into.
//
// Measured on the live message table before this fix (2026-08-11): the card
// said the receipt stays pending FOREVER; it does not, and the difference
// matters for what the fix has to do. Every such receipt did reach a terminal
// status -- but by way of a delivery timeout roughly an hour later (ids 1598,
// 1600, 1604, 1665 all flipped to `failed` ~60 minutes after creation), or
// because a human closed it by hand (1855, closed 12 minutes in). So the cost
// is not an immortal row: it is an hour of a healthy system reporting a stalled
// delegation, every single time a subsystem task closes.
//
// The receipt is still WRITTEN. Suppressing it would keep the message log
// tidy and lose the record of how the subsystem's task ended -- and that
// record is read by exactly the audits that would otherwise ask.

beforeAll(() => { initDatabase(':memory:') })

const closeAndReceipt = (from: string, to: string, content = 'do the thing') => {
  const msg = createAgentMessage(from, to, content)
  markMessageDone(msg.id, 'megvan')
  return createCompletionReceipt(getAgentMessage(msg.id)!, 'done', 'megvan')
}

describe('who can be sent a receipt at all', () => {
  it('knows the subsystems have no inbox', () => {
    expect(hasAgentMailbox('scheduler')).toBe(false)
    expect(hasAgentMailbox('costops')).toBe(false)
    expect(hasAgentMailbox('system')).toBe(false)
  })

  it('treats every other name as an agent that can receive one', () => {
    // Fails towards DELIVERING. A receipt wrongly closed is a delegator who
    // never learns their result and has no way to notice; a receipt wrongly
    // left pending is visible noise. Of the two, only the first is silent.
    expect(hasAgentMailbox('marveen')).toBe(true)
    expect(hasAgentMailbox('atlas')).toBe(true)
    expect(hasAgentMailbox('an-agent-added-next-year')).toBe(true)
  })
})

describe('closing a message that came from a subsystem', () => {
  it('leaves nothing pending for it', () => {
    // The property the watchdog reads. Asserted on the queue rather than on
    // the receipt's own field, because "zero pending for this recipient" is
    // literally what the flow-watchdog measures.
    const receipt = closeAndReceipt('scheduler', 'marveen', '[scheduler-alert] a nightly task failed')
    expect(receipt).not.toBeNull()
    expect(getPendingMessages('scheduler')).toHaveLength(0)
  })

  it('still records the outcome, rather than swallowing it', () => {
    const receipt = closeAndReceipt('costops', 'marveen', '[quota-guard] quota exceeded')!
    const stored = getAgentMessage(receipt.id)!
    expect(stored.status).toBe('done')
    expect(stored.content).toContain('[Eredmény]')
    expect(stored.content).toContain('megvan')
    // Says WHY it was closed unread, so the row is not mistaken later for a
    // receipt somebody actually read.
    expect(stored.result).toMatch(/nem kézbesíthető/)
  })
})

describe('closing a message that came from a real agent', () => {
  it('leaves the receipt pending, because it is going to be delivered', () => {
    const receipt = closeAndReceipt('atlas', 'prisma')!
    expect(getAgentMessage(receipt.id)!.status).toBe('pending')
    expect(getPendingMessages('atlas').map((m) => m.id)).toContain(receipt.id)
  })
})

describe('the receipt rule itself', () => {
  it('does not answer a receipt with a receipt', () => {
    const msg = createAgentMessage('atlas', 'prisma', '[Eredmény] msg_id:1 status:done\n\nkesz')
    markMessageDone(msg.id)
    expect(createCompletionReceipt(getAgentMessage(msg.id)!, 'done')).toBeNull()
  })

  it('does not answer a message an agent sent to itself', () => {
    const msg = createAgentMessage('atlas', 'atlas', 'note to self')
    markMessageDone(msg.id)
    expect(createCompletionReceipt(getAgentMessage(msg.id)!, 'done')).toBeNull()
  })
})

// The list of subsystems is a closed set in one place. This is what keeps it
// honest: a fourth subsystem added next year would otherwise reintroduce the
// exact bug, silently, and the first sign would be a watchdog alert nobody can
// explain.
describe('the subsystem list against the senders in the source', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full)
      return e.name.endsWith('.ts') ? [full] : []
    })

  it('names every literal sender that is not an agent', () => {
    // Every createAgentMessage('literal', ...) in the source. An agent name is
    // fine here; anything else is a subsystem and must be in the set.
    const senders = new Set<string>()
    for (const file of sourceFiles(join(PROJECT_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/createAgentMessage\(\s*'([a-z0-9_-]+)'/g)) senders.add(m[1])
    }
    // A guard that finds nothing to guard is the failure it exists to catch.
    expect(senders.size).toBeGreaterThan(0)

    // The agent names that legitimately appear as literal senders. Kept short
    // on purpose: if this list has to grow, that is worth noticing too.
    const knownAgentLiterals = new Set(['marveen'])
    const unaccounted = [...senders].filter(
      (s) => !SUBSYSTEM_SENDERS.has(s) && !knownAgentLiterals.has(s),
    )
    expect(
      unaccounted,
      `literal sender(s) that are neither a known agent nor a declared subsystem: ${unaccounted.join(', ')}. ` +
      'If one of these is a subsystem, add it to SUBSYSTEM_SENDERS -- otherwise its completion receipts ' +
      'will sit pending until a delivery timeout, and every watchdog pass will read that as a stall.',
    ).toEqual([])
  })
})
