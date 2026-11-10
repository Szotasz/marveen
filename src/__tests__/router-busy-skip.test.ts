import { describe, expect, it } from 'vitest'
import { busyRowAction, type BusyMemo } from '../web/router-busy-skip.js'

const ordinary = { from_agent: 'peer', content: 'hello', urgent: 0, stop_authorized: 0, affects_current_work: null }
const minAge = 45_000
const memo: BusyMemo = { janitorTried: false }

function action(
  currentMemo: BusyMemo | undefined = memo,
  msg: Parameters<typeof busyRowAction>[1] = ordinary,
  ageMs = 0,
  worksourceServing = false,
) {
  return busyRowAction(currentMemo, msg, ageMs, worksourceServing, minAge, 'orin')
}

describe('busyRowAction', () => {
  it('a: checks when there is no memo', () => {
    expect(busyRowAction(undefined, ordinary, 120_000, false, minAge, 'orin')).toBe('check')
  })
  it('b: checks worksource rows even with a memo', () => {
    expect(action(memo, ordinary, 120_000, true)).toBe('check')
  })
  it('c: checks urgent rows even with a memo', () => {
    expect(action(memo, { ...ordinary, urgent: 1 }, 120_000)).toBe('check')
  })
  it('d: checks unblock rows from the main agent even with a memo', () => {
    expect(action(memo, { ...ordinary, from_agent: 'orin', affects_current_work: 'unblocks' }, 120_000)).toBe('check')
  })
  it('e: tries the janitor for an old row if it has not been tried', () => {
    expect(action(memo, ordinary, minAge + 1)).toBe('janitor')
  })
  it('f: skips an ordinary young row with a memo', () => {
    expect(action()).toBe('skip')
  })
  it('checks an authorized STOP from the main agent with a memo', () => {
    expect(action(memo, { ...ordinary, from_agent: 'orin', content: '[STOP] x', stop_authorized: 1 })).toBe('check')
  })
  it('skips an unblock row from a non-main sender with a memo', () => {
    expect(action(memo, { ...ordinary, affects_current_work: 'unblocks' })).toBe('skip')
  })
  it('skips an old row when the janitor has already been tried', () => {
    expect(action({ janitorTried: true }, ordinary, 120_000)).toBe('skip')
  })
  it('skips at exactly the janitor minimum age', () => {
    expect(action(memo, ordinary, minAge)).toBe('skip')
  })
})
