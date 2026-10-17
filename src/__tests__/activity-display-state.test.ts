// The Activity card picks its badge through activityDisplayState() in
// web/app.js: an idle main thread with running background agents shows as
// 'subagents', a working main thread always wins. The function is evaluated OUT
// OF the shipped web/app.js (as kanban-owner-filter-accents.test.ts does), so a
// copy in the test cannot keep passing after the shipped code changed.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

type Entry = { state: string; bgAgents: { total: number; running: number; queued: number } | null } | null

function loadActivityDisplayState(): (entry: Entry) => string {
  const m = APP.match(/function activityDisplayState\(entry\) \{[\s\S]*?\n\}/)
  // A missing function must fail the test, not quietly produce a stub.
  if (!m) throw new Error('activityDisplayState() not found in web/app.js')
  return new Function(`${m[0]}; return activityDisplayState`)() as (entry: Entry) => string
}

const bg = (running: number, queued = 0) => ({ total: running, running, queued })

describe('activityDisplayState', () => {
  const show = loadActivityDisplayState()

  it('idle main thread with running background agents shows as subagents', () => {
    expect(show({ state: 'idle', bgAgents: bg(1) })).toBe('subagents')
    expect(show({ state: 'idle', bgAgents: bg(3, 2) })).toBe('subagents')
  })

  it('a working main thread wins over running background agents', () => {
    expect(show({ state: 'working', bgAgents: bg(2) })).toBe('working')
  })

  it('idle with no block, or a block with nothing running, stays idle', () => {
    expect(show({ state: 'idle', bgAgents: null })).toBe('idle')
    expect(show({ state: 'idle', bgAgents: { total: 1, running: 0, queued: 1 } })).toBe('idle')
  })

  it('unknown and error keep their own state', () => {
    expect(show({ state: 'unknown', bgAgents: bg(1) })).toBe('unknown')
    expect(show({ state: 'error', bgAgents: bg(1) })).toBe('error')
  })

  it('a missing entry reads unknown', () => {
    expect(show(null)).toBe('unknown')
  })
})

describe('activityDisplayState wiring', () => {
  it('the subagents state has display meta, and the card and badge go through the function', () => {
    expect(APP).toMatch(/\n  subagents: \{/)
    // Two call sites: the card's badge and the terminal card's border class.
    expect(APP.split('ACTIVITY_STATE_META[activityDisplayState(entry)]').length - 1).toBe(2)
  })
})
