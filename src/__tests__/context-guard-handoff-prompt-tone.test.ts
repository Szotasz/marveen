// The three handoff requests the guard can send are worded differently ON
// PURPOSE, and nothing pinned that until now: the act tier tells an agent its
// context is critical and to drop what it is doing; the idle tier fires on a
// session that has been quiet, where there is nothing in flight to drop, so
// the same alarm would push a routine housekeeping restart into being handled
// as an emergency; the stale-refresh asks for an update to an artifact that
// already exists, where "write a handoff" would read as a bug.
//
// The risk is not that a sentence is missing. It is that two of them CONVERGE
// -- by a copy-paste, or by the selecting ternary flipping -- and the agent on
// the receiving end cannot tell. These assertions are therefore written as
// mutual exclusions between the tiers, not as spell-checks of one string.
//
// The selection itself is a nested ternary inside an async side-effecting
// function, so it is pinned at source level: the alarming prompt must stay the
// FALLBACK, reached only when neither the stale nor the idle prefix matched.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  handoffPrompt,
  idleFlushHandoffPrompt,
  staleRefreshHandoffPrompt,
  dailyHandoffPrompt,
  periodicHandoffPrompt,
  taskCloseHandoffPrompt,
} from '../web/context-guard-runner.js'

const PATH = '/tmp/agents/x/HANDOFF.md'

// Vocabulary that means "drop everything, this is an emergency".
const ALARM = ['kritikus', 'NE folytasd']
// Vocabulary that means "nothing is on fire, this is housekeeping".
const ROUTINE = ['Rutin karbantartás', 'nem vészhelyzet']

const act = () => handoffPrompt(93, PATH)
const idle = () => idleFlushHandoffPrompt(501_234, 45, PATH)
const stale = () => staleRefreshHandoffPrompt(37, PATH)

describe('every handoff request keeps the properties all three share', () => {
  it('carries the authenticated-directive envelope', () => {
    for (const p of [act(), idle(), stale()]) expect(p.startsWith('[CONTEXT-GUARD]')).toBe(true)
  })

  it('names the exact handoff path it was given', () => {
    for (const p of [act(), idle(), stale()]) expect(p).toContain(PATH)
  })

  it('ends the turn -- the agent must stop, not continue working', () => {
    for (const p of [act(), idle(), stale()]) expect(p).toContain('ÁLLJ MEG')
  })
})

describe('act tier: the alarm is intended here', () => {
  it('states the measured percentage it was given', () => {
    expect(act()).toContain('~93%')
  })

  it('uses the alarm vocabulary', () => {
    for (const word of ALARM) expect(act()).toContain(word)
  })

  it('does NOT reassure -- the routine wording would understate a full window', () => {
    for (const word of ROUTINE) expect(act()).not.toContain(word)
  })
})

describe('idle tier: the alarm would be false here', () => {
  it('opens by saying it is routine, before any number', () => {
    for (const word of ROUTINE) expect(idle()).toContain(word)
  })

  // The single assertion this whole file exists for: an idle agent that reads
  // "kritikus" abandons work it was never asked to abandon.
  it('carries NO alarm vocabulary', () => {
    for (const word of ALARM) expect(idle()).not.toContain(word)
  })

  it('reports the token count it measured, in thousands', () => {
    expect(idle()).toContain('~501k token')
  })

  it('rounds the token count rather than truncating it', () => {
    expect(idleFlushHandoffPrompt(1_500, 30, PATH)).toContain('~2k token')
    expect(idleFlushHandoffPrompt(1_499, 30, PATH)).toContain('~1k token')
  })

  it('states the idle period it acted on', () => {
    expect(idle()).toContain('45 perce')
  })

  // Without this, an idle agent with nothing in flight can read the request as
  // unanswerable and stall instead of stopping.
  it('says that "nothing in flight" is a complete answer', () => {
    expect(idle()).toContain('nincs félbehagyott feladatod')
  })

  it('does NOT quote a percentage -- the idle tier runs with pct unmeasured', () => {
    expect(idle()).not.toContain('%')
  })
})

describe('stale-refresh: an update, not a first write', () => {
  it('asks for a refresh of the existing file', () => {
    expect(stale()).toContain('frissítsd')
  })

  it('does NOT ask for a first write, which would read as a bug to the agent', () => {
    expect(stale()).not.toContain('írj HANDOFF.md-t')
  })

  it('states how much work the artifact no longer covers', () => {
    expect(stale()).toContain('~37 perc')
  })
})

describe('the three tiers cannot collapse into each other', () => {
  it('no two requests produce the same text for the same handoff path', () => {
    const texts = [act(), idle(), stale()]
    expect(new Set(texts).size).toBe(3)
  })

  it('the alarm and the reassurance never appear in the same request', () => {
    for (const p of [act(), idle(), stale()]) {
      const alarming = ALARM.some((w) => p.includes(w))
      const reassuring = ROUTINE.some((w) => p.includes(w))
      expect(alarming && reassuring).toBe(false)
    }
  })
})

describe('the selecting ternary keeps the alarming prompt as the fallback', () => {
  const src = readFileSync(join(process.cwd(), 'src/web/context-guard-runner.ts'), 'utf-8')
  const caseStart = src.indexOf("case 'request-handoff':")
  const caseEnd = src.indexOf("case 'restart':", caseStart)
  const block = src.slice(caseStart, caseEnd)

  it('the measure is not vacuous -- the selecting block is found and calls all three', () => {
    expect(caseStart, "request-handoff case not found").toBeGreaterThan(0)
    expect(caseEnd, 'restart case not found after it').toBeGreaterThan(caseStart)
    for (const fn of ['staleRefreshHandoffPrompt(', 'idleFlushHandoffPrompt(', 'handoffPrompt(']) {
      expect(block).toContain(fn)
    }
  })

  it('the stale prefix selects the refresh wording', () => {
    expect(block.indexOf('STALE_REFRESH_REASON_PREFIX')).toBeLessThan(block.indexOf('staleRefreshHandoffPrompt('))
  })

  it('the idle prefix selects the routine wording', () => {
    expect(block.indexOf('IDLE_FLUSH_REASON_PREFIX')).toBeLessThan(block.indexOf('idleFlushHandoffPrompt('))
  })

  // Order is the assertion: the bare handoffPrompt call must come LAST, after
  // both guarded branches. If it moves ahead of the idle branch, every idle
  // flush starts shouting.
  it('the alarming wording is reached only after both guarded branches', () => {
    const idleCall = block.indexOf('idleFlushHandoffPrompt(')
    const bare = block.lastIndexOf(': handoffPrompt(')
    // Both must be PRESENT before their order means anything: with either call
    // missing, indexOf returns -1 and the comparison passes for the wrong
    // reason. Measured -- a ternary swap leaves this assertion green without it.
    expect(idleCall).toBeGreaterThan(0)
    expect(bare).toBeGreaterThan(0)
    expect(bare).toBeGreaterThan(idleCall)
  })
})

// HANDOFFKARTYA1118: at a customer, a fresh session continued from the kanban
// alone and dropped an agreed HANDOFF item that had no card. Every request that
// asks for a first handoff now asks, per Next Steps item, for the card id or the
// marker "KÁRTYA NÉLKÜL"; the seed handoff skill uses the same marker, so the
// writer and the template cannot drift apart.
describe('every first-write handoff request asks for a card id or the no-card marker per Next Steps item', () => {
  const MARKER = 'KÁRTYA NÉLKÜL'
  const requests: Array<[string, () => string]> = [
    ['act', act],
    ['idle', idle],
    ['daily', () => dailyHandoffPrompt('04:00', PATH)],
    ['periodic', () => periodicHandoffPrompt(30, PATH)],
    ['task-close', () => taskCloseHandoffPrompt(PATH)],
  ]
  for (const [label, make] of requests) {
    it(label, () => {
      const p = make()
      expect(p).toContain('a Next Steps MINDEN tétele mellé írd a kártyája azonosítóját')
      expect(p).toContain(`"${MARKER}"`)
    })
  }

  it('the seed handoff skill asks for the same marker in its Next Steps template', () => {
    // DOCKERI18N1119: the base path is the Hungarian text, i18n/en/ the English one; both carry the marker.
    const skill = readFileSync(join(process.cwd(), 'i18n/en/seed-skills/handoff/SKILL.md'), 'utf-8')
    const nextSteps = skill.slice(skill.indexOf('## Next Steps'), skill.indexOf('### 3. Deliver'))
    expect(nextSteps.length).toBeGreaterThan(0)
    expect(nextSteps).toContain('kanban card ID or the marker `KÁRTYA NÉLKÜL` (no card)')
    // and the closing paragraph no longer reads as "the kanban is the full list"
    expect(skill).toContain('the kanban is not the full to-do list either')
    const hu = readFileSync(join(process.cwd(), 'seed-skills/handoff/SKILL.md'), 'utf-8')
    const huNextSteps = hu.slice(hu.indexOf('## Next Steps'), hu.indexOf('### 3. Kézbesítés'))
    expect(huNextSteps.length).toBeGreaterThan(0)
    expect(huNextSteps).toContain(`\`${MARKER}\``)
    expect(hu).toContain('A kanban viszont nem is a teljes teendőlista')
  })
})
