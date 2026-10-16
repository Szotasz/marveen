import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearParkedInputUnderLane } from '../web/channel-monitor.js'
import { withSessionSendLock, __resetSessionSendLocks } from '../web/session-send-lock.js'

// CLEARLANE925: the clear-only stuck-input actions must not clear the box while
// a delivery is still typing into it. Measured 2026-09-25: five times in five
// hours the watcher cleared the head of a half-typed scheduled prompt, and the
// tail was submitted as a headless prompt 2-4s later.

afterEach(() => {
  __resetSessionSendLocks()
})

describe('clearParkedInputUnderLane', () => {
  it('does not clear while a delivery holds the pane lane', async () => {
    let unblock!: () => void
    const typing = new Promise<void>(res => { unblock = res })
    const delivery = withSessionSendLock('sess', null, 'deliver', async () => { await typing })
    await Promise.resolve()

    let clears = 0
    const result = await clearParkedInputUnderLane('sess', async () => { clears++; return true })

    expect(result).toBe('skipped-locked')
    expect(clears).toBe(0)
    unblock()
    await delivery
  })

  it('clears once the lane is free and reports the outcome', async () => {
    let clears = 0
    expect(await clearParkedInputUnderLane('sess', async () => { clears++; return true })).toBe('cleared')
    expect(await clearParkedInputUnderLane('sess', async () => { clears++; return false })).toBe('left-fragment')
    expect(clears).toBe(2)
  })

  it('holds the lane during the clear, so a delivery cannot start typing mid-clear', async () => {
    const order: string[] = []
    let releaseClear!: () => void
    const clearGate = new Promise<void>(res => { releaseClear = res })
    const clearing = clearParkedInputUnderLane('sess', async () => {
      order.push('clear-start')
      await clearGate
      order.push('clear-end')
      return true
    })
    await Promise.resolve()
    const delivery = withSessionSendLock('sess', null, 'deliver', async () => { order.push('deliver') })
    await Promise.resolve()
    releaseClear()
    await clearing
    await delivery
    expect(order).toEqual(['clear-start', 'clear-end', 'deliver'])
  })
})

describe('the clear-only stuck-input actions route through the lane', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const caseBody = (name: string): string => {
    const start = src.indexOf(`case '${name}': {`)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('break\n', start))
  }

  it.each(['clear-preamble', 'clear-scheduled'])('%s clears via clearParkedInputUnderLane, never a bare clearInputBuffer', name => {
    const body = caseBody(name)
    expect(body).toMatch(/clearParkedInputUnderLane\(session\)/)
    expect(body).not.toMatch(/clearInputBuffer\(/)
  })
})
